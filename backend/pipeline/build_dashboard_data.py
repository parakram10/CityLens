"""CityLens bridge: detector output -> dashboard data.

Reads the detector's detections.json, geolocates every issue with the GPS emitter,
enriches it into the dashboard's issue shape, simulates repeat bus passes, collapses
same-location sightings so a spot is never plotted twice, and writes js/live.js.

    python3 build_dashboard_data.py \
        --detections ../detector/outputs/run_x/detections.json \
        --data ../../js/data.js --out ../../js/live.js

live.js is a generated, git-ignorable artifact loaded between data.js and app.js:
it trims the seed pothole/garbage down to a few mocked pins, then pushes the real
detections into DATA.issues and points the Fleet replay at them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from gps_emitter import GpsEmitter, haversine_m, offset_m

# --- Tuning knobs -----------------------------------------------------------------
TRIM_TYPES = {"pothole", "garbage_pile"}   # seed categories replaced by real detections
KEEP_SEED_PER_TRIM_TYPE = 6                # how many seed pins to keep per trimmed type
MERGE_RADIUS_M = 20.0                      # same-type sightings within this distance = one issue
AVG_SPEED_KMPH = 8.0                        # fallback speed for the NO-motion case. With a motion
                                           # profile, the real traveled distance (estimate_motion's
                                           # distance_m) sets how far along the route we move.
GPS_JITTER_M = 6.0                         # per-pass positional noise (simulates GPS drift)
PASSES_MIN, PASSES_MAX = 1, 4              # a spot is sensed on this many bus passes
PASS_INTERVAL_DAYS = 2.0                   # spacing between passes
STREET = "Western Express Hwy"             # the A-71 corridor these detections sit on
ROUTE = "A-71"
FALLBACK_NOW = "2026-07-05T09:00:00+00:00"

# Detector issue_type / issue_group -> dashboard type.
TYPE_MAP = {
    "pothole": "pothole",
    "garbage": "garbage_pile",
    "litter": "garbage_pile",
    "roadside_litter": "garbage_pile",
}
GROUP_MAP = {"road_defect": "pothole", "waste_litter": "garbage_pile"}


def rand01(*parts: Any) -> float:
    """Deterministic pseudo-random in [0, 1) — keeps regenerated output stable."""
    digest = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF


# --- Read DATA out of js/data.js --------------------------------------------------
def load_data_js(path: Path) -> dict[str, Any]:
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("const DATA") or stripped.startswith("var DATA"):
            _, _, rhs = stripped.partition("=")
            return json.loads(rhs.strip().rstrip(";"))
    raise ValueError(f"Could not find 'const DATA = {{...}}' in {path}")


# --- Ward lookup (point in polygon against the wards GeoJSON) ----------------------
def point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-15) + xi:
            inside = not inside
        j = i
    return inside


def iter_rings(geometry: dict[str, Any]):
    """Yield every coordinate ring from a Polygon or MultiPolygon geometry."""
    def is_point(x: Any) -> bool:
        return isinstance(x, list) and len(x) == 2 and all(isinstance(v, (int, float)) for v in x)

    def walk(node: Any):
        if isinstance(node, list) and node and is_point(node[0]):
            yield node
        elif isinstance(node, list):
            for child in node:
                yield from walk(child)

    yield from walk(geometry.get("coordinates", []))


def ward_for(lat: float, lon: float, wards: dict[str, Any]) -> tuple[str, str]:
    best = None
    for feat in wards["features"]:
        props = feat["properties"]
        for ring in iter_rings(feat["geometry"]):
            if point_in_ring(lon, lat, ring):
                return props["ward"], props.get("area", "")
        d = (props["cx"] - lon) ** 2 + (props["cy"] - lat) ** 2   # cx=lon, cy=lat
        if best is None or d < best[0]:
            best = (d, props["ward"], props.get("area", ""))
    return (best[1], best[2]) if best else ("A", "")


def nearest_street(lat: float, lon: float, streets: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Closest street centroid — slots a detection into main's ward->street drill-down nav.
    The nav filters issues by streetId/wardId, so every injected pin needs a street."""
    best = None
    for s in streets:
        try:
            d = (float(s["lat"]) - lat) ** 2 + (float(s["lon"]) - lon) ** 2
        except (KeyError, TypeError, ValueError):
            continue
        if best is None or d < best[0]:
            best = (d, s)
    return best[1] if best else None


# --- Enrichment -------------------------------------------------------------------
def dash_type(issue: dict[str, Any]) -> str | None:
    t = str(issue.get("issue_type", "")).lower()
    if t in TYPE_MAP:
        return TYPE_MAP[t]
    return GROUP_MAP.get(str(issue.get("issue_group", "")).lower())


def severity_for(conf: float, bbox: list[int] | None, w: int, h: int) -> int:
    """1-5 triage score from confidence + relative box size (app's own heuristic)."""
    area_frac = 0.0
    if bbox and w and h:
        area_frac = max(0.0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) / float(w * h))
    score = 0.65 * min(1.0, max(0.0, conf)) + 0.35 * min(1.0, area_frac / 0.15)
    return max(1, min(5, round(1 + score * 4)))


def status_for(passes: int) -> str:
    return "confirmed" if passes >= 3 else ("reported" if passes == 2 else "candidate")


BOX_STYLE = {   # BGR box colour + display label, keyed by detector issue_type
    "pothole": ((48, 48, 220), "Pothole"),
    "garbage": ((60, 168, 72), "Garbage"),
    "garbage_pile": ((60, 168, 72), "Garbage"),
    "waterlogging": ((200, 140, 40), "Waterlogging"),
    "obstruction": ((40, 150, 240), "Obstruction"),
}


def render_boxed_evidence(summary: dict[str, Any], evidence_root: Path) -> dict[str, str]:
    """Draw each issue's OWN detection box on its full source frame (a single, type-coloured
    box) and save to <evidence_root>/boxed/<issue_id>.jpg. Returns {issue_id: 'boxed/<id>.jpg'}.

    This is what keeps a pothole pin's evidence from showing the frame's garbage boxes and
    vice-versa: instead of copying the detector's all-boxes annotated frame, we re-open the
    SOURCE clip at the detection's own frame and draw just its box. No model inference — the
    frame index + bbox already live in detections.json. Returns {} (caller falls back to the
    crop / annotated frame) when cv2 or the source clip isn't available."""
    try:
        import cv2  # lazy: the bridge can also run under a python without cv2 installed
    except ImportError:
        return {}
    source = summary.get("source")
    if not source or not Path(source).exists():
        return {}
    # Best (highest-confidence) detection per issue: its frame_index + bbox = the sharpest view.
    reps: dict[str, dict[str, Any]] = {}
    for det in summary.get("detections", []):
        iid = det.get("issue_id")
        if not iid or det.get("bbox_xyxy") is None or det.get("frame_index") is None:
            continue
        if iid not in reps or det.get("confidence_pct", 0) > reps[iid].get("confidence_pct", 0):
            reps[iid] = det
    if not reps:
        return {}
    out_dir = evidence_root / "boxed"
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return {}
    cap = cv2.VideoCapture(str(source))
    result: dict[str, str] = {}
    try:
        for iid, det in reps.items():
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(det["frame_index"]))
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            color, label = BOX_STYLE.get(det.get("issue_type", ""),
                                         ((60, 60, 60), str(det.get("issue_type", "issue")).title()))
            x1, y1, x2, y2 = (int(v) for v in det["bbox_xyxy"])
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 3)
            text = f"{label} {round(det.get('confidence_pct', 0))}%"
            (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)
            top = (y1 - th - 10) if (y1 - th - 10) >= 0 else (y2 + 2)   # keep label on-screen
            cv2.rectangle(frame, (x1, top), (x1 + tw + 8, top + th + 8), color, -1)
            cv2.putText(frame, text, (x1 + 4, top + th + 4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
            if cv2.imwrite(str(out_dir / f"{iid}.jpg"), frame):
                result[iid] = f"boxed/{iid}.jpg"
    finally:
        cap.release()
    return result


def build_sightings(
    issues: list[dict[str, Any]], emitter: GpsEmitter, video: dict[str, Any],
    buses: list[str], evidence_root: Path | None = None,
    boxed: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Turn each detected issue into N geolocated pass-sightings (with GPS jitter)."""
    w, h = int(video.get("width", 0)), int(video.get("height", 0))
    now = _parse_now(video)
    boxed = boxed or {}
    sightings: list[dict[str, Any]] = []
    for issue in issues:
        dtype = dash_type(issue)
        if dtype is None:
            continue
        iid = issue.get("issue_id", "issue")
        # Evidence for this issue: prefer the full source frame with ONLY this issue's own box
        # (render_boxed_evidence) so a pothole pin never shows the frame's garbage boxes; fall
        # back to the tight crop, then the all-boxes annotated frame. Path is run-dir-relative.
        ev_rel = boxed.get(iid) or issue.get("crop_path") or issue.get("screen_grab_path")
        evsrc = str(evidence_root / ev_rel) if (evidence_root and ev_rel) else None
        # Geolocate at the LAST frame the issue is seen: that's when the object is at
        # the camera (the vehicle drives over/past it), so the pin sits on the real
        # spot rather than ~30 m early where it first appeared on the horizon.
        ts = float(issue.get("last_timestamp_sec", issue.get("first_timestamp_sec", 0.0)))
        base_lat, base_lon, _ = emitter.locate(ts)
        conf = float(issue.get("peak_confidence_pct", 0.0)) / 100.0
        sev = severity_for(conf, issue.get("bbox_xyxy"), w, h)
        # One sighting per detected issue: within a single trip a spot is "seen once"
        # (a cluster of nearby same-type detections still collapses to one pin below).
        # Cross-trip persistence — the pass counter — is derived later in consolidate_runs()
        # from how many DISTINCT trips re-detect the same spot, not from a within-trip fan-out.
        sightings.append({
            "type": dtype, "lat": base_lat, "lon": base_lon, "conf": conf, "sev": sev,
            "bus": ROUTE, "t": now, "video_ts": ts, "evsrc": evsrc,
        })
    return sightings


def _c(a: float) -> float:
    import math
    return math.cos(a)


def _s(a: float) -> float:
    import math
    return math.sin(a)


def _parse_now(video: dict[str, Any]) -> datetime:
    raw = video.get("_completed_at") or FALLBACK_NOW
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return datetime.fromisoformat(FALLBACK_NOW)


# --- Spatial de-dup: same-type sightings within MERGE_RADIUS_M collapse to one -----
def merge_sightings(sightings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    clusters: list[dict[str, Any]] = []
    for s in sorted(sightings, key=lambda x: x["t"]):
        target = None
        for c in clusters:
            if c["type"] == s["type"] and haversine_m((c["lat"], c["lon"]), (s["lat"], s["lon"])) <= MERGE_RADIUS_M:
                target = c
                break
        if target is None:
            clusters.append({"type": s["type"], "lat": s["lat"], "lon": s["lon"], "members": [s]})
        else:
            target["members"].append(s)
            n = len(target["members"])   # running-mean centroid
            target["lat"] += (s["lat"] - target["lat"]) / n
            target["lon"] += (s["lon"] - target["lon"]) / n

    # Consolidation: greedy assignment can leave two clusters whose centroids later
    # drifted within MERGE_RADIUS_M. Repeatedly fuse any such same-type pair until no
    # two final pins of the same type sit closer than the merge radius.
    changed = True
    while changed:
        changed = False
        for a in range(len(clusters)):
            for b in range(a + 1, len(clusters)):
                ca, cb = clusters[a], clusters[b]
                if ca["type"] == cb["type"] and haversine_m(
                    (ca["lat"], ca["lon"]), (cb["lat"], cb["lon"])
                ) <= MERGE_RADIUS_M:
                    ca["members"].extend(cb["members"])
                    n = len(ca["members"])
                    ca["lat"] = sum(m["lat"] for m in ca["members"]) / n
                    ca["lon"] = sum(m["lon"] for m in ca["members"]) / n
                    clusters.pop(b)
                    changed = True
                    break
            if changed:
                break
    return clusters


def cluster_to_issue(cluster: dict[str, Any], pin_id: str, wards: dict[str, Any],
                     streets: list[dict[str, Any]], ward_area: dict[str, str],
                     run_id: str, bus: str) -> dict[str, Any]:
    members = sorted(cluster["members"], key=lambda m: m["t"])
    ward, area = ward_for(cluster["lat"], cluster["lon"], wards)
    # Slot the pin into main's ward->street drill-down by nearest street centroid, and keep the
    # ward consistent with that street so issues.filter(streetId) / streets.filter(wardId) line up.
    s = nearest_street(cluster["lat"], cluster["lon"], streets)
    street_id = s["id"] if s else None
    street_name = s["name"] if s else STREET
    if s:
        ward = s["wardId"]
        area = ward_area.get(ward, area)
    passes = len(members)
    # Every pin in a run belongs to that run's single bus (one trip = one bus).
    history = [{"t": _iso(m["t"]), "bus": bus, "detected": True} for m in members]
    best = max(members, key=lambda m: m["conf"])   # evidence from the sharpest sighting
    return {
        "id": pin_id,
        "runId": run_id,
        "type": cluster["type"],
        "severity": max(m["sev"] for m in members),
        "confidence": round(max(m["conf"] for m in members), 2),
        "lat": round(cluster["lat"], 5),
        "lon": round(cluster["lon"], 5),
        "ward": ward,
        "wardId": ward,
        "area": area,
        "street": street_name,
        "streetId": street_id,
        "bus": bus,
        "route": ROUTE,
        "first_seen": _iso(members[0]["t"]),
        "last_seen": _iso(members[-1]["t"]),
        "passes": passes,
        "status": status_for(passes),
        "history": history,
        "on_route": True,
        "_order": min(m["video_ts"] for m in members),   # replay order along the route
        "_evsrc": best.get("evsrc"),                      # detector image to copy in
    }


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _copy_evidence(live_issues: list[dict[str, Any]], evidence_dir: Path) -> int:
    """Copy each issue's real detector image to assets/evidence/<id>.jpg and set
    issue['photo']. Missing/unreadable images just leave the issue without a photo
    (the drawer falls back to the schematic)."""
    try:
        evidence_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        for issue in live_issues:   # can't write evidence — drop the markers, keep pins
            issue.pop("_evsrc", None)
        return 0
    n = 0
    for issue in live_issues:
        src = issue.pop("_evsrc", None)
        if not src or not Path(src).exists():
            continue
        try:
            shutil.copyfile(src, evidence_dir / f"{issue['id']}.jpg")
            issue["photo"] = f"assets/evidence/{issue['id']}.jpg"
            n += 1
        except OSError:
            continue
    return n


# --- Seed trim: keep a few mocked pins per trimmed category ------------------------
def keep_seed_ids(seed_issues: list[dict[str, Any]]) -> list[str]:
    keep: list[str] = []
    for t in TRIM_TYPES:
        pool = [i for i in seed_issues if i.get("type") == t]
        by_status: dict[str, list[dict[str, Any]]] = {}
        for i in pool:
            by_status.setdefault(i.get("status", "reported"), []).append(i)
        # Round-robin across statuses so the kept few stay varied (KPIs stay alive).
        picked: list[str] = []
        queues = list(by_status.values())
        qi = 0
        while len(picked) < KEEP_SEED_PER_TRIM_TYPE and any(queues):
            q = queues[qi % len(queues)]
            if q:
                picked.append(q.pop(0)["id"])
            qi += 1
            if not any(queues):
                break
        keep.extend(picked)
    return keep


# --- live.js emitter --------------------------------------------------------------
def render_live_js(
    live_issues: list[dict[str, Any]], keep_ids: list[str], replay_ids: list[str], src: str,
    runs_meta: list[dict[str, Any]],
) -> str:
    payload = json.dumps(live_issues, ensure_ascii=False)
    keep = json.dumps(keep_ids)
    replay = json.dumps(replay_ids)
    trim = json.dumps(sorted(TRIM_TYPES))
    runs_js = json.dumps(runs_meta, ensure_ascii=False)
    return f"""// GENERATED by backend/pipeline/build_dashboard_data.py — do not edit by hand.
// Source: {src}
// Loaded between js/data.js and js/app.js. Trims the seed pothole/garbage down to a few
// mocked pins and injects every detector run's de-duplicated detections into DATA.issues.
(function () {{
  var LIVE_ISSUES = {payload};
  var KEEP_SEED = new Set({keep});
  var TRIM_TYPES = new Set({trim});
  // Drop most seed pins in the trimmed categories; keep every other category intact.
  DATA.issues = DATA.issues.filter(function (i) {{
    return !TRIM_TYPES.has(i.type) || KEEP_SEED.has(i.id);
  }});
  Array.prototype.push.apply(DATA.issues, LIVE_ISSUES);
  // Point the Fleet & replay view at the real detections, in route order.
  if (Array.isArray(DATA.replay_ids)) DATA.replay_ids = {replay};
  // Each detector run is one Fleet trip: {{id,label,bus,date,distance_km,video,motion,feed}}.
  // Pins carry runId so the trip list & replay can group them; motion/feed drive the replay.
  window.CITYLENS_LIVE = {{ count: LIVE_ISSUES.length, runs: {runs_js} }};
}})();
"""


# --- Runs registry: each detector run = one Fleet trip ----------------------------

def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def load_manifest(path: str | Path) -> dict[str, Any]:
    p = Path(path)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"runs": []}


def save_manifest(path: str | Path, manifest: dict[str, Any]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(manifest, indent=2))


def next_seq(manifest: dict[str, Any]) -> int:
    return max((int(r.get("seq", 0)) for r in manifest["runs"]), default=0) + 1


def upsert_run(manifest: dict[str, Any], entry: dict[str, Any]) -> None:
    """Replace the run with the same id in place, else append — re-running a clip never dupes."""
    for i, r in enumerate(manifest["runs"]):
        if r["id"] == entry["id"]:
            manifest["runs"][i] = entry
            return
    manifest["runs"].append(entry)


def motion_payload(emitter: GpsEmitter) -> dict[str, Any] | None:
    """Real distance covered (km) + a subsampled cumulative-distance curve for the replay."""
    if not getattr(emitter, "_motion_t", None):
        return None
    pts = list(zip(emitter._motion_t, emitter._motion_cum))
    stepn = max(1, len(pts) // 300)          # ~300 points keeps live.js small
    cum = [[round(t, 2), round(c, 5)] for t, c in pts[::stepn]]
    if cum and cum[-1][0] != round(pts[-1][0], 2):
        cum.append([round(pts[-1][0], 2), round(pts[-1][1], 5)])
    return {"distance_km": round(emitter.traverse_m / 1000.0, 3), "cum": cum}


def build_feed(detector_issues: list[dict[str, Any]], video: dict[str, Any],
               evidence_root: Path, run_dir: Path, run_id: str) -> list[dict[str, Any]]:
    """Timed 'detections dropping in' list for the replay, from the raw detector output.
    Copies each crop into runs/<id>/crops/ so the feed shows real thumbnails."""
    w, h = int(video.get("width", 0)), int(video.get("height", 0))
    crops_dir = run_dir / "crops"
    feed: list[dict[str, Any]] = []
    for x in detector_issues:
        dt = dash_type(x)
        if dt is None:
            continue
        conf = float(x.get("peak_confidence_pct", 0.0)) / 100.0
        crop = None
        cp = x.get("crop_path")
        if cp and (evidence_root / cp).exists():
            try:
                crops_dir.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(evidence_root / cp, crops_dir / Path(cp).name)
                crop = f"runs/{run_id}/crops/{Path(cp).name}"
            except OSError:
                pass
        feed.append({
            "id": x.get("issue_id"), "type": dt,
            "severity": severity_for(conf, x.get("bbox_xyxy"), w, h),
            "confidence": round(conf, 2),
            "t": round(float(x.get("first_timestamp_sec", 0.0)), 1),
            "crop": crop,
        })
    feed.sort(key=lambda f: f["t"])
    return feed


def link_run_video(evidence_root: Path, run_dir: Path, run_id: str,
                   source: str | Path | None = None) -> str | None:
    """Publish the run's annotated clip into runs/<id>/ (gitignored, local-only). Returns the
    web path, or None if there's no clip (replay then falls back to the simulated timeline).

    We publish the detector's annotated.mp4 — detection boxes drawn per frame. The cyan road-ROI
    trapezium that used to be burned in alongside them is disabled via config (`road_roi.draw:
    false`); the ROI still gates litter (`enabled: true`), it's just no longer drawn, so the clip
    reads as clean dashcam + boxes. (`source` is the raw clip, kept only as a last-resort fallback
    if the annotated frames are missing.)

    OpenCV writes annotated.mp4 as MPEG-4 Part 2 (fourcc FMP4/mp4v) — a codec no browser decodes in
    a <video>, so we transcode to H.264 + faststart (moov atom up front) via ffmpeg. Without ffmpeg
    we symlink the raw file (won't play in-browser, but keeps it addressable)."""
    src = evidence_root / "annotated.mp4"
    if not src.exists() and source and Path(source).exists():
        src = Path(source)
    if not src.exists():
        return None
    web_path = f"runs/{run_id}/annotated.mp4"
    try:
        run_dir.mkdir(parents=True, exist_ok=True)
        out = run_dir / "annotated.mp4"
        if out.is_symlink() or out.exists():
            out.unlink()

        if shutil.which("ffmpeg"):
            tmp = run_dir / ".annotated.web.mp4"
            cmd = [
                "ffmpeg", "-y", "-loglevel", "error", "-i", str(src.resolve()),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24",
                "-preset", "veryfast", "-movflags", "+faststart", "-an", str(tmp),
            ]
            try:
                subprocess.run(cmd, check=True)
                tmp.replace(out)
                return web_path
            except (subprocess.CalledProcessError, OSError) as exc:
                print(f"  !! ffmpeg transcode failed ({exc}); symlinking raw clip "
                      f"(won't play in-browser).", flush=True)
                if tmp.exists():
                    tmp.unlink()

        out.symlink_to(src.resolve())
        return web_path
    except OSError:
        return None


def build_run_entry(args: Any, data: dict[str, Any], manifest: dict[str, Any],
                    run_id: str, runs_dir: Path, root: Path) -> dict[str, Any]:
    """Geolocate + de-dup one detector run into a manifest entry (pins + feed + motion + meta)."""
    summary = json.loads(Path(args.detections).read_text())
    video = dict(summary.get("video", {}))
    video["_completed_at"] = summary.get("completed_at_utc")
    fps = float(video.get("fps", 30.0)) or 30.0
    duration = (int(video.get("last_frame_index", 0)) + 1) / fps
    max_length_m = (AVG_SPEED_KMPH / 3.6) * duration if duration else None
    emitter = GpsEmitter.from_file(
        args.track, duration_override=None if args.motion else (duration or None),
        motion_path=args.motion, max_length_m=max_length_m,
    )
    # Stable trip metadata: reuse the existing entry's fields when re-running the same clip.
    existing = next((r for r in manifest["runs"] if r["id"] == run_id), None)
    buses = data.get("buses", [])
    seq = existing["seq"] if existing else next_seq(manifest)
    bus = args.bus or (existing["bus"] if existing
                       else (buses[(seq - 1) % len(buses)] if buses else "MH01"))
    date = args.date or (existing["date"] if existing else _today())
    label = args.label or (existing.get("label") if existing else None) or f"Trip {seq} · {date}"

    detector_issues = summary.get("issues") or summary.get("detections") or []
    evidence_root = Path(args.detections).resolve().parent
    boxed = render_boxed_evidence(summary, evidence_root)   # full frame, this-issue's-box-only
    sightings = build_sightings(detector_issues, emitter, video, buses, evidence_root, boxed)
    for sg in sightings:
        sg["bus"] = bus                              # one run = one bus
    clusters = merge_sightings(sightings)
    clusters.sort(key=lambda c: min(m["video_ts"] for m in c["members"]))
    streets = data.get("streets", [])
    ward_area = {f["properties"]["ward"]: f["properties"].get("area", "")
                 for f in data["wards"].get("features", [])}
    pins = [cluster_to_issue(c, f"CL-{seq}-{n:03d}", data["wards"], streets, ward_area, run_id, bus)
            for n, c in enumerate(clusters, 1)]
    _copy_evidence(pins, root / "assets" / "evidence")
    for p in pins:
        p.pop("_order", None)
        p.pop("_evsrc", None)

    run_dir = runs_dir / run_id
    return {
        "id": run_id, "seq": seq, "label": label, "bus": bus, "date": date,
        "partial": bool(summary.get("partial")),
        "distance_km": round(emitter.traverse_m / 1000.0, 3),
        "video": link_run_video(evidence_root, run_dir, run_id, summary.get("source")),
        "motion": motion_payload(emitter),
        "feed": build_feed(detector_issues, video, evidence_root, run_dir, run_id),
        "pins": pins,
    }


def consolidate_runs(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse same-type pins across ALL runs that sit within MERGE_RADIUS_M into one
    city issue, and count real cross-trip persistence.

    passes = the number of DISTINCT trips (runs) that independently re-detected the spot.
    One trip that sees a cluster at a place contributes exactly 1 (whatever within-trip
    de-dup already happened); the counter only climbs when a *different* trip re-detects
    the same type at the same location. `runIds` lists every trip that saw it, so the Fleet
    can still show the issue as a stop on each of those trips. The pass history is rebuilt
    from the run registry (one row per trip: its date + bus), not from the pins' rows."""
    run_meta = {r["id"]: {"date": r.get("date", ""), "bus": r.get("bus", ROUTE)} for r in runs}
    # Feed pins to the same-type / MERGE_RADIUS_M clusterer; `t` is only a stable sort key.
    pins = [dict(p, t=(p.get("first_seen") or run_meta.get(p.get("runId"), {}).get("date", "")))
            for r in runs for p in r["pins"]]
    issues: list[dict[str, Any]] = []
    for cluster in merge_sightings(pins):
        members = cluster["members"]
        rep = max(members, key=lambda m: m.get("confidence", 0.0))   # sharpest sighting anchors the pin
        run_ids = sorted({m["runId"] for m in members if m.get("runId")},
                         key=lambda rid: run_meta.get(rid, {}).get("date", ""))
        issue = {k: v for k, v in rep.items() if k != "t"}
        issue["runId"] = rep.get("runId")            # keep a singular runId (legacy reads) …
        issue["runIds"] = run_ids                    # … plus every trip that re-saw the spot
        issue["passes"] = len(run_ids)
        issue["status"] = status_for(len(run_ids))
        issue["severity"] = max(m.get("severity", 1) for m in members)
        issue["confidence"] = round(max(m.get("confidence", 0.0) for m in members), 2)
        history = [{"t": f"{run_meta[rid]['date']}T09:00:00Z",
                    "bus": run_meta[rid]["bus"], "detected": True}
                   for rid in run_ids if rid in run_meta]
        issue["history"] = history
        if history:
            issue["first_seen"] = history[0]["t"]
            issue["last_seen"] = history[-1]["t"]
        issues.append(issue)
    issues.sort(key=lambda i: i["id"])
    return issues


def regenerate(manifest: dict[str, Any], data: dict[str, Any], out_path: Path,
               root: Path) -> dict[str, Any]:
    """Rebuild js/live.js + js/live.json from every run in the manifest."""
    runs = manifest["runs"]
    # Cross-trip de-dup: same spot seen on N trips = one issue with passes=N (not N pins).
    all_pins = consolidate_runs(runs)
    meta_keys = ("id", "label", "bus", "date", "distance_km", "video", "motion", "feed")
    runs_meta = [{k: r.get(k) for k in meta_keys} for r in runs]
    keep_ids = keep_seed_ids(data.get("issues", []))
    replay_ids = [p["id"] for p in all_pins]

    # Drop evidence images for pins that no longer exist (e.g. a re-run merged more).
    live_ids = {p["id"] for p in all_pins}
    ev = root / "assets" / "evidence"
    if ev.exists():
        for f in ev.glob("CL-*.jpg"):
            if f.stem not in live_ids:
                try:
                    f.unlink()
                except OSError:
                    pass

    out_path.write_text(render_live_js(all_pins, keep_ids, replay_ids, f"{len(runs)} run(s)", runs_meta))
    rev = f"{len(all_pins)}:{sum(int(p['passes']) for p in all_pins)}"
    partial = any(r.get("partial") for r in runs)
    out_path.with_suffix(".json").write_text(json.dumps(
        {"rev": rev, "partial": partial, "issues": all_pins,
         "replay": replay_ids, "runs": runs_meta}))
    by_type: dict[str, int] = {}
    for p in all_pins:
        by_type[p["type"]] = by_type.get(p["type"], 0) + 1
    return {"runs": len(runs), "pins": len(all_pins), "by_type": by_type}


def main() -> None:
    here = Path(__file__).resolve().parent
    root = here.parent.parent
    ap = argparse.ArgumentParser(
        description="Add a detector run to the Fleet registry and rebuild js/live.js.")
    ap.add_argument("--detections", default=None,
                    help="Detector detections.json for THIS run. Omit (with --regen) to just "
                         "rebuild live.js from the existing manifest.")
    ap.add_argument("--data", default=str(root / "js" / "data.js"),
                    help="Path to js/data.js (wards + streets + seed to trim).")
    ap.add_argument("--track", default=str(here / "gps_track.json"), help="GPS route file.")
    ap.add_argument("--motion", default=None, help="Motion profile from estimate_motion.py.")
    ap.add_argument("--out", default=str(root / "js" / "live.js"), help="Output live.js.")
    ap.add_argument("--manifest", default=str(root / "runs" / "index.json"), help="Runs manifest.")
    ap.add_argument("--runs-dir", default=str(root / "runs"), help="Per-run bundle dir.")
    ap.add_argument("--run-id", default=None,
                    help="Stable id for this run (default: the detector run folder name).")
    ap.add_argument("--bus", default=None, help="Bus to file the trip under (default: round-robin).")
    ap.add_argument("--label", default=None, help="Trip label (default: 'Trip N · <date>').")
    ap.add_argument("--date", default=None, help="Trip date YYYY-MM-DD (default: today).")
    ap.add_argument("--regen", action="store_true",
                    help="Only rebuild live.js from the manifest; don't add a run.")
    args = ap.parse_args()

    data = load_data_js(Path(args.data))
    manifest = load_manifest(args.manifest)

    added = None
    if args.detections and not args.regen:
        run_id = args.run_id or Path(args.detections).resolve().parent.name
        added = build_run_entry(args, data, manifest, run_id, Path(args.runs_dir), root)
        upsert_run(manifest, added)
        save_manifest(args.manifest, manifest)

    stats = regenerate(manifest, data, Path(args.out), root)
    if added:
        print(f"run '{added['id']}' -> bus {added['bus']} · {added['date']} · "
              f"{len(added['pins'])} pins · {added['distance_km']} km")
    print(f"manifest: {stats['runs']} run(s) -> {stats['pins']} pins {stats['by_type']}; "
          f"wrote {args.out}")


if __name__ == "__main__":
    main()
