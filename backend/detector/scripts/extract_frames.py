"""Extract frames from video(s) to build a litter-detection training set.

Pulls frames at a fixed spacing (and optionally only where the current litter
models already fire, to bias toward litter-containing frames). The output folder
is ready to upload to a labeling tool (Roboflow / CVAT / Label Studio).

Usage:
    # every 15th frame from one video
    python scripts/extract_frames.py /path/to/vid1.mp4 --stride 15 --out dataset/images

    # only frames where the litter model already sees something (fast bootstrap)
    python scripts/extract_frames.py /path/to/vid1.mp4 --stride 10 --litter-only --out dataset/images
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("videos", nargs="+", help="One or more video paths.")
    parser.add_argument("--out", default="dataset/images", help="Output image folder.")
    parser.add_argument("--stride", type=int, default=15, help="Save every Nth frame.")
    parser.add_argument("--max-per-video", type=int, default=400, help="Cap per video.")
    parser.add_argument(
        "--litter-only",
        action="store_true",
        help="Only save frames where litter_yolov8m_aryanshh fires (biases toward litter).",
    )
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    model = None
    if args.litter_only:
        from ultralytics import YOLO

        model = YOLO(str(PROJECT_ROOT / "models/litter_yolov8m_aryanshh_best.pt"))

    total = 0
    for vpath in args.videos:
        cap = cv2.VideoCapture(vpath)
        if not cap.isOpened():
            print(f"skip (cannot open): {vpath}")
            continue
        stem = Path(vpath).stem
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        saved = 0
        for i in range(0, n, args.stride):
            if saved >= args.max_per_video:
                break
            cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            ok, fr = cap.read()
            if not ok:
                continue
            if model is not None:
                dev = None if args.device == "auto" else args.device
                r = model.predict(fr, imgsz=1280, conf=0.12, verbose=False,
                                  **({"device": dev} if dev else {}))[0]
                if r.boxes is None or len(r.boxes) == 0:
                    continue
            cv2.imwrite(str(out / f"{stem}_{i:06d}.jpg"), fr)
            saved += 1
            total += 1
        cap.release()
        print(f"{vpath}: saved {saved} frames")
    print(f"\nTotal: {total} frames in {out}")
    print("Next: upload this folder to a labeling tool and draw boxes on road-level litter.")


if __name__ == "__main__":
    main()
