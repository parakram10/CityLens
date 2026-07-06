"""Diagnose why (or whether) an issue is detected on a single image.

Two passes:
  1. REAL PIPELINE - runs the exact app pipeline (tiling, COCO suppressor, all
     spatial filters) and prints the final detections it would emit.
  2. RAW PROBE - runs each model full-frame at a LOW confidence and reports, per
     detection, which filter (confidence / class / size / road-region) would drop
     it. This tells you whether a miss is a MODEL problem (nothing detected at
     all) or a FILTER problem (detected but discarded by config.yaml).

Usage:
    python scripts/diagnose_image.py path/to/frame.jpg --device mps --save debug.jpg
    python scripts/diagnose_image.py frame.jpg --conf 0.03
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from civic_issue_detector.config import load_config  # noqa: E402
from civic_issue_detector.detector import (  # noqa: E402
    CivicIssueDetector,
    normalize_label,
    point_in_polygon,
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="Path to an image (a saved video frame / screengrab).")
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--conf", type=float, default=0.05,
                        help="Probe confidence for the RAW pass (low). Default 0.05.")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--save", default=None, help="Write an annotated debug image here.")
    args = parser.parse_args()

    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = PROJECT_ROOT / config_path
    config = load_config(config_path)

    frame = cv2.imread(str(args.image))
    if frame is None:
        raise SystemExit(f"Could not read image: {args.image}")
    height, width = frame.shape[:2]
    print(f"Image: {args.image}  ({width}x{height})\n")

    detector = CivicIssueDetector(
        config.models, PROJECT_ROOT, device=args.device,
        suppressor_config=config.suppressor, road_roi_config=config.road_roi,
    )
    annotated = frame.copy()
    roi_px = detector.road_roi_polygon_px(width, height)
    roi_poly = [(px * width, py * height) for px, py in config.road_roi.polygon] \
        if (config.road_roi.enabled and config.road_roi.polygon) else []
    roi_groups = set(config.road_roi.apply_to_issue_groups)
    if roi_px and len(roi_px) >= 3:
        import numpy as _np
        cv2.polylines(annotated, [_np.array(roi_px, _np.int32).reshape((-1, 1, 2))],
                      True, (255, 255, 0), 2)

    # --- Pass 1: the real pipeline (what the app actually emits) ---
    final = detector.predict_frame(frame, 0, 0.0)
    print(f"=== REAL PIPELINE (tiling + suppressor + filters): {len(final)} detection(s) ===")
    for d in final:
        print(f"    KEEP  {d.issue_type:16s} {d.confidence_pct:5.1f}%  {d.raw_class}  bbox={d.bbox_xyxy}")
        x1, y1, x2, y2 = d.bbox_xyxy
        cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 220, 0), 3)
        cv2.putText(annotated, f"{d.issue_type} {d.confidence_pct:.0f}%", (x1, max(14, y1 - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 220, 0), 2, cv2.LINE_AA)
    print()

    # --- Pass 2: raw full-frame probe per model, with per-filter verdicts ---
    print(f"=== RAW PROBE at conf>={args.conf} (full-frame, explains drops) ===")
    for spec, model in detector.models:
        include_norm = {normalize_label(v) for v in spec.include_classes}
        kwargs = {"source": frame, "conf": args.conf, "iou": spec.iou_threshold,
                  "imgsz": spec.image_size, "verbose": False}
        if detector.device is not None:
            kwargs["device"] = detector.device
        results = model.predict(**kwargs)
        names = results[0].names if results else {}
        boxes = results[0].boxes if results and results[0].boxes is not None else []
        print(f"\n  --- {spec.name}  (conf_thresh={spec.confidence_threshold}, "
              f"tiling={'on' if spec.tile_inference else 'off'}) : {len(boxes)} raw ---")
        for b in boxes:
            conf = float(b.conf[0]); cls = int(b.cls[0]); raw = str(names.get(cls, cls))
            x1, y1, x2, y2 = (int(v) for v in b.xyxy[0].tolist())
            area_r = (max(0, x2 - x1) * max(0, y2 - y1)) / float(width * height)
            w_r = max(0, x2 - x1) / width; h_r = max(0, y2 - y1) / height
            cy_r = ((y1 + y2) / 2.0) / height; by_r = y2 / height
            reasons = []
            if conf < spec.confidence_threshold:
                reasons.append(f"conf<{spec.confidence_threshold}")
            if include_norm and normalize_label(raw) not in include_norm:
                reasons.append("class-excluded")
            if cy_r < spec.min_center_y_ratio:
                reasons.append(f"too-high({cy_r:.2f})")
            if by_r < spec.min_bottom_y_ratio:
                reasons.append(f"bottom-high({by_r:.2f})")
            if area_r > spec.max_box_area_ratio:
                reasons.append(f"too-big-area({area_r:.3f})")
            if w_r > spec.max_box_width_ratio:
                reasons.append(f"too-wide({w_r:.2f})")
            if h_r > spec.max_box_height_ratio:
                reasons.append(f"too-tall({h_r:.2f})")
            if roi_poly and spec.issue_group in roi_groups:
                tx = (x1 + x2) / 2.0
                ty = float(y2) if config.road_roi.test_point != "center" else (y1 + y2) / 2.0
                if not point_in_polygon(tx, ty, roi_poly):
                    reasons.append("outside-road-ROI")
            verdict = "keep" if not reasons else "DROP"
            print(f"    [{verdict}] {raw:14s} conf={conf:.2f} area={area_r:.3f} w={w_r:.2f} "
                  f"h={h_r:.2f}  {'' if not reasons else '-> ' + ', '.join(reasons)}")
            if reasons:
                cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 0, 210), 1)

    if args.save:
        cv2.imwrite(str(args.save), annotated)
        print(f"\nAnnotated debug image written to: {args.save}  "
              "(thick green = emitted, thin red = detected-but-dropped)")


if __name__ == "__main__":
    main()
