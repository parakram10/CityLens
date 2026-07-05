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


def build_sightings(
    issues: list[dict[str, Any]], emitter: GpsEmitter, video: dict[str, Any],
    buses: list[str], evidence_root: Path | None = None,
) -> list[dict[str, Any]]:
    """Turn each detected issue into N geolocated pass-sightings (with GPS jitter)."""
    w, h = int(video.get("width", 0)), int(video.get("height", 0))
    now = _parse_now(video)
    sightings: list[dict[str, Any]] = []
    for issue in issues:
        dtype = dash_type(issue)
        if dtype is None:
            continue
        # The detector's real evidence for this issue: prefer the annotated frame
        # (box + label), fall back to the tight crop. Path is relative to the run dir.
        ev_rel = issue.get("screen_grab_path") or issue.get("crop_path")
        evsrc = str(evidence_root / ev_rel) if (evidence_root and ev_rel) else None
        # Geolocate at the LAST frame the issue is seen: that's when the object is at
        # the camera (the vehicle drives over/past it), so the pin sits on the real
        # spot rather than ~30 m early where it first appeared on the horizon.
        ts = float(issue.get("last_timestamp_sec", issue.get("first_timestamp_sec", 0.0)))
        base_lat, base_lon, _ = emitter.locate(ts)
        conf = float(issue.get("peak_confidence_pct", 0.0)) / 100.0
        sev = severity_for(conf, issue.get("bbox_xyxy"), w, h)
        iid = issue.get("issue_id", "issue")
        passes = PASSES_MIN + int(rand01(iid, "passes") * (PASSES_MAX - PASSES_MIN + 1))
        for k in range(passes):
            ang = rand01(iid, k, "ang") * 6.283185
            dist = rand01(iid, k, "dist") * GPS_JITTER_M
            lat, lon = offset_m(base_lat, base_lon, dist * _c(ang), dist * _s(ang))
            # Newest pass at "now", older passes spaced back in time.
            t = now - timedelta(days=(passes - 1 - k) * PASS_INTERVAL_DAYS,
                                hours=rand01(iid, k, "h") * 6)
            sightings.append({
                "type": dtype, "lat": lat, "lon": lon, "conf": conf, "sev": sev,
                "bus": buses[int(rand01(iid, k, "bus") * len(buses))] if buses else ROUTE,
                "t": t, "video_ts": ts, "evsrc": evsrc,
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


def cluster_to_issue(cluster: dict[str, Any], idx: int, wards: dict[str, Any],
                     streets: list[dict[str, Any]], ward_area: dict[str, str]) -> dict[str, Any]:
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
    history = [{"t": _iso(m["t"]), "bus": m["bus"], "detected": True} for m in members]
    best = max(members, key=lambda m: m["conf"])   # evidence from the sharpest sighting
    return {
        "id": f"CL-L{idx:03d}",
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
        "bus": members[-1]["bus"],
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
    motion: dict[str, Any] | None = None,
) -> str:
    payload = json.dumps(live_issues, ensure_ascii=False)
    keep = json.dumps(keep_ids)
    replay = json.dumps(replay_ids)
    trim = json.dumps(sorted(TRIM_TYPES))
    motion_js = json.dumps(motion) if motion else "null"
    return f"""// GENERATED by pipeline/build_dashboard_data.py — do not edit by hand.
// Source: {src}
// Loaded between js/data.js and js/app.js. Trims the seed pothole/garbage down to a
// few mocked pins and injects the real detector output geolocated onto the A-71 route.
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
  // Real motion pacing (distance covered + cumulative curve) for the Fleet replay.
  window.CITYLENS_LIVE = {{ count: LIVE_ISSUES.length, motion: {motion_js} }};
}})();
"""


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description="Build js/live.js from detector output.")
    ap.add_argument("--detections", default=str(here / "sample_detections.json"),
                    help="Path to the detector's detections.json.")
    ap.add_argument("--data", default=str(here.parent.parent / "js" / "data.js"),
                    help="Path to js/data.js (source of wards + seed to trim).")
    ap.add_argument("--track", default=str(here / "gps_track.json"), help="GPS route file.")
    ap.add_argument("--motion", default=None,
                    help="Optional motion profile from estimate_motion.py — makes the "
                         "route pacing follow the video (stops, speed-ups) instead of "
                         "constant speed.")
    ap.add_argument("--out", default=str(here.parent.parent / "js" / "live.js"), help="Output live.js.")
    ap.add_argument("--gpx", default=None, help="Optional: also dump the mock GPS track as GPX.")
    args = ap.parse_args()

    summary = json.loads(Path(args.detections).read_text())
    data = load_data_js(Path(args.data))
    video = dict(summary.get("video", {}))
    video["_completed_at"] = summary.get("completed_at_utc")
    fps = float(video.get("fps", 30.0)) or 30.0
    duration = (int(video.get("last_frame_index", 0)) + 1) / fps
    # With a motion profile, its estimated speed drives both pacing AND how far along the
    # route we travel (its distance_m, used inside from_file). Without one, fall back to a
    # constant realistic speed. Either way we move a believable distance and trim the rest
    # of the corridor, which is what keeps same-spot re-detections within the merge radius.
    max_length_m = (AVG_SPEED_KMPH / 3.6) * duration if duration else None
    emitter = GpsEmitter.from_file(
        args.track,
        duration_override=None if args.motion else (duration or None),
        motion_path=args.motion,
        max_length_m=max_length_m,
    )

    detector_issues = summary.get("issues") or summary.get("detections") or []
    evidence_root = Path(args.detections).resolve().parent   # crops/grabs are relative to this
    sightings = build_sightings(
        detector_issues, emitter, video, data.get("buses", []), evidence_root
    )
    clusters = merge_sightings(sightings)
    streets = data.get("streets", [])
    ward_area = {f["properties"]["ward"]: f["properties"].get("area", "")
                 for f in data["wards"].get("features", [])}
    live_issues = [cluster_to_issue(c, n + 1, data["wards"], streets, ward_area)
                   for n, c in enumerate(clusters)]

    # Copy each issue's real detector image into the dashboard so the drawer shows the
    # actual detected pothole/garbage frame instead of the schematic.
    citylens_root = Path(args.out).resolve().parent.parent
    evidence_dir = citylens_root / "assets" / "evidence"
    n_photos = _copy_evidence(live_issues, evidence_dir)

    keep_ids = keep_seed_ids(data.get("issues", []))
    replay_ids = [i["id"] for i in sorted(live_issues, key=lambda x: x.get("_order", 0.0))]
    for i in live_issues:
        i.pop("_order", None)
        i.pop("_evsrc", None)
    src_name = Path(args.detections).name
    # Real motion pacing for the Fleet replay: distance actually covered (km) + a subsampled
    # cumulative-distance curve, so the replay's km readout and marker follow the video's true
    # speed (slow crawl, stops) instead of a fixed fake route length.
    motion_payload = None
    if getattr(emitter, "_motion_t", None):
        pts = list(zip(emitter._motion_t, emitter._motion_cum))
        stepn = max(1, len(pts) // 300)          # ~300 points keeps live.js small
        cum = [[round(t, 2), round(c, 5)] for t, c in pts[::stepn]]
        if cum and cum[-1][0] != round(pts[-1][0], 2):
            cum.append([round(pts[-1][0], 2), round(pts[-1][1], 5)])
        motion_payload = {"distance_km": round(emitter.traverse_m / 1000.0, 3), "cum": cum}
    Path(args.out).write_text(
        render_live_js(live_issues, keep_ids, replay_ids, src_name, motion_payload)
    )
    # live.json — same payload the dashboard polls to update in place without a reload.
    # `rev` changes whenever a pin is added or gains a pass, so the poller only re-renders
    # on real change.
    rev = f"{len(live_issues)}:{sum(int(i['passes']) for i in live_issues)}"
    partial = bool(summary.get("partial"))
    Path(args.out).with_suffix(".json").write_text(
        json.dumps({"rev": rev, "partial": partial, "issues": live_issues,
                    "replay": replay_ids, "motion": motion_payload})
    )

    if args.gpx:
        from gps_emitter import write_gpx
        write_gpx(emitter, args.gpx)

    by_type: dict[str, int] = {}
    for i in live_issues:
        by_type[i["type"]] = by_type.get(i["type"], 0) + 1
    pacing = f"video motion ({Path(args.motion).name})" if args.motion else "constant speed"
    avg_kmph = emitter.traverse_m / duration * 3.6 if duration else 0.0
    print(
        f"{len(detector_issues)} detected issue(s) -> {len(sightings)} pass-sightings "
        f"-> {len(live_issues)} deduped pins {by_type}\n"
        f"copied {n_photos} real detection image(s) into {evidence_dir}\n"
        f"kept {len(keep_ids)} seed pins in {sorted(TRIM_TYPES)}; traveled "
        f"{emitter.traverse_m:.0f} m of {emitter.length_m:.0f} m route (~{avg_kmph:.0f} km/h avg); "
        f"pacing: {pacing}\nwrote {args.out}"
    )


if __name__ == "__main__":
    main()
