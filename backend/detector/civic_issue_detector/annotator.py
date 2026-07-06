from __future__ import annotations

import hashlib

import cv2
import numpy as np

from .schema import AnnotationConfig, Detection


PALETTE_BGR = [
    (0, 0, 255),
    (0, 165, 255),
    (0, 255, 255),
    (0, 255, 0),
    (255, 0, 0),
    (255, 0, 255),
    (255, 255, 0),
    (128, 0, 255),
]


def color_for_label(label: str) -> tuple[int, int, int]:
    digest = hashlib.md5(label.encode("utf-8")).hexdigest()
    idx = int(digest[:4], 16) % len(PALETTE_BGR)
    return PALETTE_BGR[idx]


def make_label(det: Detection, cfg: AnnotationConfig) -> str:
    prefix = ""
    if cfg.show_issue_id and det.issue_id:
        # "issue_000012" -> "#12"
        tail = det.issue_id.rsplit("_", 1)[-1].lstrip("0") or "0"
        prefix = f"#{tail} "
    parts = [f"{prefix}{det.issue_type.replace('_', ' ').title()} {det.confidence_pct:.1f}%"]
    extras = []
    if cfg.show_raw_class and det.raw_class.lower() != det.issue_type.lower():
        extras.append(det.raw_class)
    if cfg.show_model_name:
        extras.append(det.model_name)
    if extras:
        parts.append(f"({', '.join(extras)})")
    return " ".join(parts)


def draw_road_roi(
    annotated: np.ndarray, polygon_px: list[tuple[int, int]]
) -> None:
    """Draw the road-ROI outline in place (cyan) to help tune the polygon."""
    if not polygon_px or len(polygon_px) < 3:
        return
    pts = np.array(polygon_px, dtype=np.int32).reshape((-1, 1, 2))
    cv2.polylines(annotated, [pts], isClosed=True, color=(255, 255, 0), thickness=2)


def draw_detections(
    frame: np.ndarray,
    detections: list[Detection],
    cfg: AnnotationConfig,
    roi_polygon_px: list[tuple[int, int]] | None = None,
) -> np.ndarray:
    annotated = frame.copy()
    if roi_polygon_px:
        draw_road_roi(annotated, roi_polygon_px)
    for det in detections:
        x1, y1, x2, y2 = det.bbox_xyxy
        color = color_for_label(det.issue_type)
        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, cfg.box_thickness)

        label = make_label(det, cfg)
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = cfg.font_scale
        thickness = max(1, cfg.box_thickness - 1)
        (text_w, text_h), baseline = cv2.getTextSize(label, font, font_scale, thickness)
        pad = 4
        label_x1 = x1
        label_y1 = max(0, y1 - text_h - baseline - 2 * pad)
        label_x2 = min(annotated.shape[1] - 1, label_x1 + text_w + 2 * pad)
        label_y2 = min(annotated.shape[0] - 1, label_y1 + text_h + baseline + 2 * pad)

        cv2.rectangle(annotated, (label_x1, label_y1), (label_x2, label_y2), color, -1)
        cv2.putText(
            annotated,
            label,
            (label_x1 + pad, label_y2 - baseline - pad),
            font,
            font_scale,
            (255, 255, 255),
            thickness,
            cv2.LINE_AA,
        )
    return annotated
