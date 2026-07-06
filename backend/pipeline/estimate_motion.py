"""Camera motion estimator (visual-odometry front end) for the CityLens demo.

The dashcam has no GPS, so we recover *pacing* — when the vehicle moves, slows, and
stops — straight from the pixels. We track sparse features frame-to-frame with
Lucas-Kanade optical flow, take the robust median displacement in the road region as
a forward-speed proxy, subtract the vibration noise floor, smooth, and integrate to a
normalized cumulative-distance curve.

That curve feeds gps_emitter: `locate(t)` maps video time -> distance-along-route via
cum(t), so detections land where the *video actually was* (crawling at a signal, fast
on the flyover) instead of at a fake constant speed. It does not recover absolute
metres (a single camera has no scale) — only relative pacing, which is exactly what a
mocked route needs.

    python3 estimate_motion.py --video assets/vid-1.mp4 --out pipeline/motion_vid-1.json

Output JSON:
    { "video", "fps", "duration_sec", "frames", "sample_fps",
      "samples": [ { "t": <sec>, "speed": <proxy>, "cum": <0..1> }, ... ],
      "stats": { "moving_fraction", "peak_speed", "mean_speed" } }
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

# LK params — a small pyramid handles fast highway motion without losing slow crawl.
_LK = dict(winSize=(21, 21), maxLevel=3,
           criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))


def _road_mask(h: int, w: int, roi_top: float, roi_bottom: float) -> np.ndarray:
    """Track only the road band (below the horizon, above the hood): cleaner, faster
    flow that scales with speed. Sky/buildings up top add noise; the hood is static."""
    mask = np.zeros((h, w), dtype=np.uint8)
    y0, y1 = int(h * roi_top), int(h * roi_bottom)
    mask[y0:y1, :] = 255
    return mask


def estimate(
    video_path: str,
    target_fps: float = 8.0,
    roi_top: float = 0.45,
    roi_bottom: float = 0.92,
    max_features: int = 400,
    min_tracked: int = 12,
    stop_quantile: float = 0.15,
    smooth_sec: float = 1.0,
    max_frames: int | None = None,
    avg_kmph: float = 8.0,
    max_kmph: float = 30.0,
) -> dict:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    if fps <= 1e-3 or fps > 240:
        fps = 30.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    stride = max(1, round(fps / target_fps))
    dt = stride / fps  # seconds between sampled frames

    times: list[float] = []
    raw_speed: list[float] = []
    prev_gray: np.ndarray | None = None
    mask: np.ndarray | None = None
    last_speed = 0.0
    idx = -1

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        idx += 1
        if max_frames is not None and idx >= max_frames:
            break
        if idx % stride != 0:
            continue

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if prev_gray is None:
            prev_gray = gray
            mask = _road_mask(gray.shape[0], gray.shape[1], roi_top, roi_bottom)
            continue

        pts = cv2.goodFeaturesToTrack(
            prev_gray, maxCorners=max_features, qualityLevel=0.01,
            minDistance=8, mask=mask,
        )
        speed = last_speed  # carry through tracking dropouts / scene cuts
        if pts is not None and len(pts) >= min_tracked:
            nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev_gray, gray, pts, None, **_LK)
            good = st.reshape(-1) == 1
            if good.sum() >= min_tracked:
                disp = np.linalg.norm((nxt[good] - pts[good]).reshape(-1, 2), axis=1)
                speed = float(np.median(disp)) / dt  # px/sec, robust to moving objects

        times.append(round(idx / fps, 3))
        raw_speed.append(speed)
        last_speed = speed
        prev_gray = gray

    cap.release()
    duration = frame_count / fps if frame_count else (times[-1] if times else 0.0)

    if not raw_speed:
        raise RuntimeError("No frames processed — empty or unreadable video.")

    speed_px = _postprocess(np.asarray(raw_speed), dt, stop_quantile, smooth_sec)

    # Calibrate optical flow (px/s) -> absolute m/s. A monocular camera has no scale, so
    # we anchor the AVERAGE to a realistic survey speed (avg_kmph) and clamp the peak
    # (max_kmph). The shape over time is the video's real motion; only the scale is
    # assumed. Distance is the integral of this speed = how far along the route the clip
    # travels; the route is trimmed to it (we never traverse the whole corridor).
    # Anchor the TYPICAL (median of moving samples) speed to avg_kmph — "mostly around
    # 20" — which is robust to the flow's occasional spikes; then clamp the peak.
    moving_px = speed_px[speed_px > 1e-6]
    ref_px = float(np.median(moving_px)) if moving_px.size else float(speed_px.mean() or 0.0)
    scale = (avg_kmph / 3.6) / ref_px if ref_px > 1e-9 else 0.0
    speed_mps = np.clip(speed_px * scale, 0.0, max_kmph / 3.6)
    if speed_mps.size > 1:
        dist = np.concatenate([[0.0], np.cumsum((speed_mps[:-1] + speed_mps[1:]) * 0.5 * dt)])
    else:
        dist = np.zeros(speed_mps.size)
    distance_m = float(dist[-1]) if dist.size else 0.0
    cum = dist / distance_m if distance_m > 1e-9 else np.linspace(0.0, 1.0, len(speed_mps))
    speed_kmph = speed_mps * 3.6

    samples = [
        {"t": t, "speed_kmph": round(float(s), 3), "cum": round(float(c), 6)}
        for t, s, c in zip(times, speed_kmph, cum)
    ]
    moving = float((speed_mps > 1e-6).mean()) if speed_mps.size else 0.0
    return {
        "video": video_path,
        "fps": round(fps, 3),
        "duration_sec": round(duration, 3),
        "frames": frame_count,
        "sample_fps": round(fps / stride, 3),
        "sample_stride": stride,
        "n_samples": len(samples),
        "avg_kmph": avg_kmph,
        "max_kmph": max_kmph,
        "distance_m": round(distance_m, 1),   # how far the vehicle traveled = route trim length
        "stats": {
            "moving_fraction": round(moving, 3),
            "peak_kmph": round(float(speed_kmph.max()), 2) if speed_kmph.size else 0.0,
            "mean_kmph": round(float(speed_kmph.mean()), 2) if speed_kmph.size else 0.0,
        },
        "samples": samples,
    }


def _postprocess(raw: np.ndarray, dt: float, stop_quantile: float, smooth_sec: float) -> np.ndarray:
    """Remove the constant vibration/road-texture baseline, clamp, and smooth."""
    floor = np.quantile(raw, stop_quantile) if raw.size else 0.0
    speed = np.clip(raw - floor, 0.0, None)
    win = max(1, int(round(smooth_sec / dt)))
    if win > 1 and speed.size >= win:
        kernel = np.ones(win) / win
        speed = np.convolve(speed, kernel, mode="same")
    return speed


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description="Estimate dashcam motion pacing via optical flow.")
    ap.add_argument("--video", required=True, help="Path to the dashcam clip.")
    ap.add_argument("--out", default=None, help="Output JSON (default: pipeline/motion_<name>.json).")
    ap.add_argument("--fps", type=float, default=8.0, help="Target sampling rate (Hz).")
    ap.add_argument("--roi-top", type=float, default=0.45, help="Top of road band (frac of height).")
    ap.add_argument("--roi-bottom", type=float, default=0.92, help="Bottom of road band (frac of height).")
    ap.add_argument("--max-frames", type=int, default=None, help="Stop early (quick test).")
    ap.add_argument("--avg-kmph", type=float, default=8.0,
                    help="Assumed typical speed (median) to anchor the absolute scale (default 8).")
    ap.add_argument("--max-kmph", type=float, default=30.0,
                    help="Clamp instantaneous speed to this (default 30).")
    args = ap.parse_args()

    out = args.out or str(here / f"motion_{Path(args.video).stem}.json")
    result = estimate(
        args.video, target_fps=args.fps,
        roi_top=args.roi_top, roi_bottom=args.roi_bottom, max_frames=args.max_frames,
        avg_kmph=args.avg_kmph, max_kmph=args.max_kmph,
    )
    Path(out).write_text(json.dumps(result, indent=2))
    s = result["stats"]
    print(
        f"{args.video}: {result['duration_sec']:.0f}s, {result['n_samples']} samples "
        f"@ {result['sample_fps']:.1f}fps\n"
        f"  moving {s['moving_fraction']*100:.0f}% of the clip | mean {s['mean_kmph']:.1f} km/h | "
        f"peak {s['peak_kmph']:.1f} km/h | distance traveled {result['distance_m']:.0f} m\n"
        f"  wrote {out}"
    )


if __name__ == "__main__":
    main()
