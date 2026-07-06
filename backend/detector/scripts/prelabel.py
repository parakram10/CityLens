"""Pre-label extracted frames with draft YOLO boxes to speed up annotation.

Runs the current litter model over an images folder and writes YOLO-format label
files (one .txt per image) plus a classes.txt. You then open the folder in a
labeling tool (labelImg / CVAT / Label Studio) and CORRECT the drafts: delete
wrong boxes (cars, stalls, people, walls), fix loose boxes, and ADD litter the
model missed. Correcting is far faster than drawing from scratch.

IMPORTANT: these drafts are a starting point, NOT ground truth. The model both
misses real litter and invents false boxes - your review is what makes the data
good.

Usage:
    python scripts/prelabel.py dataset/images --conf 0.10
    python scripts/prelabel.py dataset/images --conf 0.08 --roi   # skip sky/boards
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from civic_issue_detector.config import load_config  # noqa: E402
from civic_issue_detector.detector import point_in_polygon  # noqa: E402

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp"}
# Single class keeps a first model simple and usually trains better. Change to
# ["litter", "garbage_pile"] if you want the split, and map below.
CLASS_NAMES = ["litter"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("images_dir", help="Folder of extracted frames.")
    parser.add_argument("--labels-dir", default=None, help="Where to write .txt (default: <images_dir>/../labels).")
    parser.add_argument("--conf", type=float, default=0.10, help="Low bar - review will prune. Default 0.10.")
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--roi", action="store_true", help="Skip draft boxes outside the config road_roi.")
    args = parser.parse_args()

    from ultralytics import YOLO

    cfg = load_config(PROJECT_ROOT / args.config if not Path(args.config).is_absolute() else args.config)
    litter_specs = [m for m in cfg.models if m.issue_group == "waste_litter"]
    # Prefer the pretrained YOLOv8m litter model for drafts.
    spec = next((m for m in litter_specs if "yolov8m" in m.name), litter_specs[0])
    weights = spec.weights if Path(spec.weights).is_absolute() else str(PROJECT_ROOT / spec.weights)
    model = YOLO(weights, task=spec.task)
    dev = None if args.device == "auto" else args.device

    images_dir = Path(args.images_dir)
    labels_dir = Path(args.labels_dir) if args.labels_dir else images_dir.parent / "labels"
    labels_dir.mkdir(parents=True, exist_ok=True)

    roi_poly_norm = cfg.road_roi.polygon if (args.roi and cfg.road_roi.enabled) else None

    imgs = [p for p in sorted(images_dir.iterdir()) if p.suffix.lower() in IMAGE_EXTS]
    total_boxes = 0
    for img_path in imgs:
        frame = cv2.imread(str(img_path))
        if frame is None:
            continue
        h, w = frame.shape[:2]
        r = model.predict(frame, imgsz=spec.image_size, conf=args.conf, verbose=False,
                          **({"device": dev} if dev else {}))[0]
        lines = []
        if r.boxes is not None:
            for box in r.boxes.xyxy.cpu().numpy():
                x1, y1, x2, y2 = box
                if roi_poly_norm is not None:
                    poly = [(px * w, py * h) for px, py in roi_poly_norm]
                    if not point_in_polygon((x1 + x2) / 2.0, float(y2), poly):
                        continue
                cx = ((x1 + x2) / 2.0) / w
                cy = ((y1 + y2) / 2.0) / h
                bw = (x2 - x1) / w
                bh = (y2 - y1) / h
                lines.append(f"0 {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
        (labels_dir / f"{img_path.stem}.txt").write_text("\n".join(lines))
        total_boxes += len(lines)

    (labels_dir / "classes.txt").write_text("\n".join(CLASS_NAMES) + "\n")
    print(f"Wrote draft labels for {len(imgs)} images ({total_boxes} boxes) to {labels_dir}")
    print("classes.txt:", CLASS_NAMES)
    print("\nNext: open the images in labelImg/CVAT/Label Studio and CORRECT the drafts")
    print("(delete cars/stalls/people/walls, tighten boxes, add missed litter).")


if __name__ == "__main__":
    main()
