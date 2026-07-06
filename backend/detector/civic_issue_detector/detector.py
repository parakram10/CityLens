from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable

import numpy as np
from ultralytics import YOLO

from .schema import Detection, ModelSpec, RoadROIConfig, SuppressorConfig


def point_in_polygon(x: float, y: float, polygon: list[tuple[float, float]]) -> bool:
    """Ray-casting point-in-polygon test. polygon is a list of (x, y) points."""
    n = len(polygon)
    if n < 3:
        return True
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def normalize_label(label: str) -> str:
    value = label.strip().lower()
    value = re.sub(r"[\s\-]+", "_", value)
    value = re.sub(r"[^a-z0-9_]+", "", value)
    return value


def bbox_iou(a: list[int], b: list[int]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    inter_w = max(0, inter_x2 - inter_x1)
    inter_h = max(0, inter_y2 - inter_y1)
    inter_area = inter_w * inter_h
    a_area = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    b_area = max(0, bx2 - bx1) * max(0, by2 - by1)
    denom = a_area + b_area - inter_area
    if denom <= 0:
        return 0.0
    return inter_area / denom


def bbox_containment(inner: list[int], outer: list[int]) -> float:
    """Fraction of ``inner``'s area that lies inside ``outer`` (intersection / inner_area)."""
    ax1, ay1, ax2, ay2 = inner
    bx1, by1, bx2, by2 = outer
    inter_w = max(0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0, min(ay2, by2) - max(ay1, by1))
    inter_area = inter_w * inter_h
    inner_area = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    if inner_area <= 0:
        return 0.0
    return inter_area / inner_area


def cross_model_nms(detections: Iterable[Detection], iou_threshold: float) -> list[Detection]:
    """Keep the highest-confidence detection for overlapping boxes of the same issue type."""
    ordered = sorted(detections, key=lambda d: d.confidence, reverse=True)
    kept: list[Detection] = []
    for det in ordered:
        should_drop = False
        for existing in kept:
            same_issue = det.issue_type == existing.issue_type or det.issue_group == existing.issue_group
            if same_issue and bbox_iou(det.bbox_xyxy, existing.bbox_xyxy) >= iou_threshold:
                should_drop = True
                break
        if not should_drop:
            kept.append(det)
    return sorted(kept, key=lambda d: (d.frame_index, d.detection_id))


class CivicIssueDetector:
    def __init__(
        self,
        model_specs: list[ModelSpec],
        project_root: str | Path,
        device: str = "auto",
        suppressor_config: SuppressorConfig | None = None,
        road_roi_config: RoadROIConfig | None = None,
    ) -> None:
        self.project_root = Path(project_root)
        self.device = self._auto_device() if device == "auto" else device
        self.road_roi = road_roi_config
        self.models: list[tuple[ModelSpec, YOLO]] = []

        enabled_specs = [spec for spec in model_specs if spec.enabled]
        if not enabled_specs:
            raise ValueError("No enabled models found in config.yaml")

        for spec in enabled_specs:
            weights_path = self._resolve_path(spec.weights)
            if not weights_path.exists():
                raise FileNotFoundError(
                    f"Weights for model '{spec.name}' not found: {weights_path}\n"
                    "Run: python scripts/download_models.py --all\n"
                    "Or edit config.yaml and point weights to your local .pt model."
                )
            self.models.append((spec, YOLO(str(weights_path), task=spec.task)))

        self.suppressor_config = suppressor_config
        self.suppressor: YOLO | None = None
        if suppressor_config is not None and suppressor_config.enabled:
            # Stock COCO weights (e.g. yolo11n.pt) are auto-downloaded by
            # Ultralytics on first use if not present locally.
            weights = suppressor_config.weights
            local = self._resolve_path(weights)
            weights_ref = str(local) if local.exists() else weights
            self.suppressor = YOLO(weights_ref, task=suppressor_config.task or "detect")

    @staticmethod
    def _auto_device() -> str | int | None:
        """Pick the best available inference device: CUDA GPU, then Apple MPS, else CPU."""
        try:
            import torch

            if torch.cuda.is_available():
                return 0
            mps = getattr(torch.backends, "mps", None)
            if mps is not None and mps.is_available():
                return "mps"
        except Exception:
            pass
        return None

    def _resolve_path(self, path_value: str) -> Path:
        path = Path(path_value)
        if path.is_absolute():
            return path
        return self.project_root / path

    def _suppression_boxes(self, frame: np.ndarray) -> list[list[int]]:
        """Run the COCO suppressor and return boxes for the configured classes."""
        cfg = self.suppressor_config
        if self.suppressor is None or cfg is None:
            return []
        kwargs = {
            "source": frame,
            "conf": cfg.confidence_threshold,
            "imgsz": cfg.image_size,
            "verbose": False,
        }
        if self.device is not None:
            kwargs["device"] = self.device
        results = self.suppressor.predict(**kwargs)
        if not results:
            return []
        result = results[0]
        names = result.names or getattr(self.suppressor, "names", {}) or {}
        if result.boxes is None or len(result.boxes) == 0:
            return []
        wanted = {normalize_label(c) for c in cfg.suppress_classes}
        boxes: list[list[int]] = []
        xyxy = result.boxes.xyxy.cpu().numpy()
        class_ids = result.boxes.cls.cpu().numpy().astype(int)
        for box, class_id in zip(xyxy, class_ids):
            name = normalize_label(str(names.get(int(class_id), int(class_id))))
            if name in wanted:
                boxes.append([int(round(float(v))) for v in box])
        return boxes

    def _apply_suppressor(
        self, detections: list[Detection], suppression_boxes: list[list[int]]
    ) -> list[Detection]:
        cfg = self.suppressor_config
        if not suppression_boxes or cfg is None:
            return detections
        groups = set(cfg.apply_to_issue_groups)
        kept: list[Detection] = []
        for det in detections:
            if det.issue_group in groups:
                drop = False
                for sb in suppression_boxes:
                    # litter sitting on a person/vehicle...
                    if bbox_containment(det.bbox_xyxy, sb) >= cfg.containment_threshold:
                        drop = True
                        break
                    # ...or a big litter box wrapping most of a person/vehicle.
                    if bbox_containment(sb, det.bbox_xyxy) >= cfg.vehicle_cover_threshold:
                        drop = True
                        break
                if drop:
                    continue
            kept.append(det)
        return kept

    @staticmethod
    def _prediction_windows(spec: ModelSpec, width: int, height: int) -> list[tuple[int, int, int, int]]:
        if not spec.tile_inference:
            return [(0, 0, width, height)]

        band_y1 = int(round(max(0.0, min(1.0, spec.tile_min_y_ratio)) * height))
        band_y2 = int(round(max(0.0, min(1.0, spec.tile_max_y_ratio)) * height))
        if band_y2 <= band_y1:
            band_y1, band_y2 = 0, height

        band_w = width
        band_h = band_y2 - band_y1
        base_tile_w = max(1, int(np.ceil(band_w / spec.tile_cols)))
        base_tile_h = max(1, int(np.ceil(band_h / spec.tile_rows)))
        overlap_x = int(round(base_tile_w * spec.tile_overlap_ratio))
        overlap_y = int(round(base_tile_h * spec.tile_overlap_ratio))

        windows: list[tuple[int, int, int, int]] = []
        for row in range(spec.tile_rows):
            for col in range(spec.tile_cols):
                x1 = col * base_tile_w
                y1 = band_y1 + row * base_tile_h
                x2 = min(width, (col + 1) * base_tile_w)
                y2 = min(band_y2, band_y1 + (row + 1) * base_tile_h)
                x1 = max(0, x1 - overlap_x)
                y1 = max(band_y1, y1 - overlap_y)
                x2 = min(width, x2 + overlap_x)
                y2 = min(band_y2, y2 + overlap_y)
                if x2 > x1 and y2 > y1:
                    windows.append((x1, y1, x2, y2))
        return windows

    def predict_frame(self, frame: np.ndarray, frame_index: int, timestamp_sec: float) -> list[Detection]:
        height, width = frame.shape[:2]
        detections: list[Detection] = []

        for spec, model in self.models:
            include_normalized = {normalize_label(v) for v in spec.include_classes}
            det_index = 0
            for tile_index, (win_x1, win_y1, win_x2, win_y2) in enumerate(
                self._prediction_windows(spec, width, height)
            ):
                crop = frame[win_y1:win_y2, win_x1:win_x2]
                crop_height, crop_width = crop.shape[:2]
                if crop_width <= 0 or crop_height <= 0:
                    continue

                kwargs = {
                    "source": crop,
                    "conf": spec.confidence_threshold,
                    "iou": spec.iou_threshold,
                    "imgsz": spec.image_size,
                    "verbose": False,
                }
                if self.device is not None:
                    kwargs["device"] = self.device

                results = model.predict(**kwargs)
                if not results:
                    continue
                result = results[0]
                names = result.names or getattr(model, "names", {}) or {}
                if result.boxes is None or len(result.boxes) == 0:
                    continue

                boxes_xyxy = result.boxes.xyxy.cpu().numpy()
                confidences = result.boxes.conf.cpu().numpy()
                class_ids = result.boxes.cls.cpu().numpy().astype(int)

                for box, confidence, class_id in zip(boxes_xyxy, confidences, class_ids):
                    raw_class = str(names.get(int(class_id), int(class_id)))
                    raw_norm = normalize_label(raw_class)
                    if include_normalized and raw_norm not in include_normalized:
                        continue

                    issue_type = self._issue_type_for(spec, raw_class)
                    local_x1, local_y1, local_x2, local_y2 = self._clip_xyxy(
                        box,
                        crop_width,
                        crop_height,
                    )
                    global_box = np.array(
                        [
                            local_x1 + win_x1,
                            local_y1 + win_y1,
                            local_x2 + win_x1,
                            local_y2 + win_y1,
                        ]
                    )
                    x1, y1, x2, y2 = self._clip_xyxy(global_box, width, height)
                    if not self._passes_spatial_filters(spec, x1, y1, x2, y2, width, height):
                        continue

                    bbox_xywh = [x1, y1, max(0, x2 - x1), max(0, y2 - y1)]
                    normalized = [x1 / width, y1 / height, x2 / width, y2 / height]
                    detection_id = f"f{frame_index:06d}_{spec.name}_{tile_index:02d}_{det_index:02d}"
                    det_index += 1
                    detections.append(
                        Detection(
                            detection_id=detection_id,
                            frame_index=frame_index,
                            timestamp_sec=float(timestamp_sec),
                            model_name=spec.name,
                            issue_group=spec.issue_group,
                            issue_type=issue_type,
                            raw_class=raw_class,
                            class_id=int(class_id),
                            confidence=float(confidence),
                            confidence_pct=float(confidence) * 100.0,
                            bbox_xyxy=[x1, y1, x2, y2],
                            bbox_xywh=bbox_xywh,
                            bbox_normalized_xyxy=normalized,
                        )
                    )

        # Reject litter outside the road region (buildings, boards, trees).
        detections = self._apply_road_roi(detections, width, height)

        # Only run the (extra) COCO suppressor pass if there is at least one
        # detection it could actually filter. On pothole-only frames this skips
        # a whole model inference.
        if self._needs_suppression(detections):
            suppression_boxes = self._suppression_boxes(frame)
            detections = self._apply_suppressor(detections, suppression_boxes)
        return detections

    def road_roi_polygon_px(self, width: int, height: int) -> list[tuple[int, int]]:
        """The ROI polygon in pixel coordinates (empty if ROI is off)."""
        cfg = self.road_roi
        if cfg is None or not cfg.enabled or not cfg.polygon:
            return []
        return [(int(round(px * width)), int(round(py * height))) for px, py in cfg.polygon]

    def _apply_road_roi(
        self, detections: list[Detection], width: int, height: int
    ) -> list[Detection]:
        cfg = self.road_roi
        if cfg is None or not cfg.enabled or not cfg.polygon:
            return detections
        polygon = [(px * width, py * height) for px, py in cfg.polygon]
        groups = set(cfg.apply_to_issue_groups)
        kept: list[Detection] = []
        for det in detections:
            if det.issue_group in groups:
                x1, y1, x2, y2 = det.bbox_xyxy
                if cfg.test_point == "center":
                    tx, ty = (x1 + x2) / 2.0, (y1 + y2) / 2.0
                else:  # bottom_center: where litter meets the ground
                    tx, ty = (x1 + x2) / 2.0, float(y2)
                if not point_in_polygon(tx, ty, polygon):
                    continue
            kept.append(det)
        return kept

    def _needs_suppression(self, detections: list[Detection]) -> bool:
        cfg = self.suppressor_config
        if self.suppressor is None or cfg is None or not detections:
            return False
        groups = set(cfg.apply_to_issue_groups)
        return any(det.issue_group in groups for det in detections)

    @staticmethod
    def _clip_xyxy(box: np.ndarray, width: int, height: int) -> list[int]:
        x1, y1, x2, y2 = [int(round(float(v))) for v in box]
        x1 = max(0, min(width - 1, x1))
        y1 = max(0, min(height - 1, y1))
        x2 = max(0, min(width - 1, x2))
        y2 = max(0, min(height - 1, y2))
        if x2 < x1:
            x1, x2 = x2, x1
        if y2 < y1:
            y1, y2 = y2, y1
        return [x1, y1, x2, y2]

    @staticmethod
    def _passes_spatial_filters(
        spec: ModelSpec,
        x1: int,
        y1: int,
        x2: int,
        y2: int,
        width: int,
        height: int,
    ) -> bool:
        if width <= 0 or height <= 0:
            return True
        center_y_ratio = ((y1 + y2) / 2.0) / height
        bottom_y_ratio = y2 / height
        box_width_ratio = max(0, x2 - x1) / width
        box_height_ratio = max(0, y2 - y1) / height
        box_area_ratio = (max(0, x2 - x1) * max(0, y2 - y1)) / float(width * height)
        if center_y_ratio < spec.min_center_y_ratio:
            return False
        if bottom_y_ratio < spec.min_bottom_y_ratio:
            return False
        if box_area_ratio > spec.max_box_area_ratio:
            return False
        if box_width_ratio > spec.max_box_width_ratio:
            return False
        if box_height_ratio > spec.max_box_height_ratio:
            return False
        return True

    @staticmethod
    def _issue_type_for(spec: ModelSpec, raw_class: str) -> str:
        if raw_class in spec.class_map:
            return normalize_label(spec.class_map[raw_class])
        raw_norm = normalize_label(raw_class)
        normalized_map = {normalize_label(k): normalize_label(v) for k, v in spec.class_map.items()}
        return normalized_map.get(raw_norm, normalize_label(spec.default_issue_type or raw_class))
