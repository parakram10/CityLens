from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .schema import (
    AnnotationConfig,
    AppConfig,
    ModelSpec,
    ProcessingConfig,
    RoadROIConfig,
    SuppressorConfig,
)


def _as_float(value: Any, default: float) -> float:
    if value is None:
        return default
    return float(value)


def _as_int(value: Any, default: int) -> int:
    if value is None:
        return default
    return int(value)


def load_config(path: str | Path) -> AppConfig:
    config_path = Path(path)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with config_path.open("r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    models = []
    for item in raw.get("models", []):
        models.append(
            ModelSpec(
                name=str(item.get("name", "model")),
                weights=str(item.get("weights", "")),
                enabled=bool(item.get("enabled", True)),
                issue_group=str(item.get("issue_group", "civic_issue")),
                default_issue_type=str(item.get("default_issue_type", "civic_issue")),
                confidence_threshold=_as_float(item.get("confidence_threshold"), 0.25),
                iou_threshold=_as_float(item.get("iou_threshold"), 0.45),
                image_size=_as_int(item.get("image_size"), 640),
                task=(str(item["task"]) if item.get("task") else None),
                include_classes=[str(v) for v in item.get("include_classes", [])],
                class_map={str(k): str(v) for k, v in (item.get("class_map") or {}).items()},
                min_center_y_ratio=max(0.0, _as_float(item.get("min_center_y_ratio"), 0.0)),
                min_bottom_y_ratio=max(0.0, _as_float(item.get("min_bottom_y_ratio"), 0.0)),
                max_box_area_ratio=max(0.0, _as_float(item.get("max_box_area_ratio"), 1.0)),
                max_box_width_ratio=max(0.0, _as_float(item.get("max_box_width_ratio"), 1.0)),
                max_box_height_ratio=max(0.0, _as_float(item.get("max_box_height_ratio"), 1.0)),
                tile_inference=bool(item.get("tile_inference", False)),
                tile_cols=max(1, _as_int(item.get("tile_cols"), 1)),
                tile_rows=max(1, _as_int(item.get("tile_rows"), 1)),
                tile_overlap_ratio=max(0.0, _as_float(item.get("tile_overlap_ratio"), 0.10)),
                tile_min_y_ratio=max(0.0, _as_float(item.get("tile_min_y_ratio"), 0.0)),
                tile_max_y_ratio=min(1.0, _as_float(item.get("tile_max_y_ratio"), 1.0)),
            )
        )

    processing_raw = raw.get("processing", {}) or {}
    processing = ProcessingConfig(
        frame_stride=max(1, _as_int(processing_raw.get("frame_stride"), 1)),
        crop_padding_ratio=max(0.0, _as_float(processing_raw.get("crop_padding_ratio"), 0.08)),
        save_annotated_video=bool(processing_raw.get("save_annotated_video", True)),
        save_detection_crops=bool(processing_raw.get("save_detection_crops", True)),
        save_screen_grabs=bool(processing_raw.get("save_screen_grabs", True)),
        cross_model_nms=bool(processing_raw.get("cross_model_nms", True)),
        cross_model_nms_iou=_as_float(processing_raw.get("cross_model_nms_iou"), 0.70),
        skip_similar_frames=bool(processing_raw.get("skip_similar_frames", True)),
        similar_frame_threshold=max(
            0.0,
            _as_float(processing_raw.get("similar_frame_threshold"), 3.5),
        ),
        similar_frame_downscale_width=max(
            16,
            _as_int(processing_raw.get("similar_frame_downscale_width"), 160),
        ),
        max_similar_frame_skips=max(
            0,
            _as_int(processing_raw.get("max_similar_frame_skips"), 8),
        ),
        persist_detections_between_inferences=bool(
            processing_raw.get("persist_detections_between_inferences", True)
        ),
        max_persisted_detection_frames=max(
            0,
            _as_int(processing_raw.get("max_persisted_detection_frames"), 0),
        ),
        temporal_dedupe=bool(processing_raw.get("temporal_dedupe", True)),
        temporal_dedupe_iou=_as_float(processing_raw.get("temporal_dedupe_iou"), 0.35),
        temporal_dedupe_grid_cols=max(
            1,
            _as_int(processing_raw.get("temporal_dedupe_grid_cols"), 8),
        ),
        temporal_dedupe_grid_rows=max(
            1,
            _as_int(processing_raw.get("temporal_dedupe_grid_rows"), 6),
        ),
        temporal_dedupe_ttl_frames=max(
            0,
            _as_int(processing_raw.get("temporal_dedupe_ttl_frames"), 300),
        ),
        track_issues=bool(processing_raw.get("track_issues", True)),
        track_iou=_as_float(processing_raw.get("track_iou"), 0.30),
        track_center_dist_ratio=max(
            0.0,
            _as_float(processing_raw.get("track_center_dist_ratio"), 0.12),
        ),
        track_motion_gate_growth=max(
            0.0,
            _as_float(processing_raw.get("track_motion_gate_growth"), 0.04),
        ),
        track_max_age_frames=max(
            0,
            _as_int(processing_raw.get("track_max_age_frames"), 45),
        ),
        track_min_hits=max(1, _as_int(processing_raw.get("track_min_hits"), 2)),
    )

    suppressor_raw = raw.get("suppressor", {}) or {}
    default_suppressor = SuppressorConfig()
    suppress_classes = suppressor_raw.get("suppress_classes")
    apply_to_groups = suppressor_raw.get("apply_to_issue_groups")
    suppressor = SuppressorConfig(
        enabled=bool(suppressor_raw.get("enabled", False)),
        weights=str(suppressor_raw.get("weights", default_suppressor.weights)),
        task=(str(suppressor_raw["task"]) if suppressor_raw.get("task") else None),
        confidence_threshold=_as_float(
            suppressor_raw.get("confidence_threshold"), default_suppressor.confidence_threshold
        ),
        image_size=_as_int(suppressor_raw.get("image_size"), default_suppressor.image_size),
        suppress_classes=(
            [str(v) for v in suppress_classes]
            if suppress_classes is not None
            else default_suppressor.suppress_classes
        ),
        containment_threshold=_as_float(
            suppressor_raw.get("containment_threshold"), default_suppressor.containment_threshold
        ),
        vehicle_cover_threshold=_as_float(
            suppressor_raw.get("vehicle_cover_threshold"),
            default_suppressor.vehicle_cover_threshold,
        ),
        apply_to_issue_groups=(
            [str(v) for v in apply_to_groups]
            if apply_to_groups is not None
            else default_suppressor.apply_to_issue_groups
        ),
    )

    roi_raw = raw.get("road_roi", {}) or {}
    default_roi = RoadROIConfig()
    roi_polygon = roi_raw.get("polygon")
    roi_groups = roi_raw.get("apply_to_issue_groups")
    road_roi = RoadROIConfig(
        enabled=bool(roi_raw.get("enabled", False)),
        polygon=(
            [[float(p[0]), float(p[1])] for p in roi_polygon]
            if roi_polygon
            else default_roi.polygon
        ),
        apply_to_issue_groups=(
            [str(v) for v in roi_groups]
            if roi_groups is not None
            else default_roi.apply_to_issue_groups
        ),
        test_point=str(roi_raw.get("test_point", default_roi.test_point)),
        draw=bool(roi_raw.get("draw", default_roi.draw)),
    )

    annotation_raw = raw.get("annotation", {}) or {}
    annotation = AnnotationConfig(
        box_thickness=max(1, _as_int(annotation_raw.get("box_thickness"), 2)),
        font_scale=_as_float(annotation_raw.get("font_scale"), 0.60),
        show_raw_class=bool(annotation_raw.get("show_raw_class", True)),
        show_model_name=bool(annotation_raw.get("show_model_name", False)),
        show_issue_id=bool(annotation_raw.get("show_issue_id", True)),
    )

    return AppConfig(
        models=models,
        processing=processing,
        annotation=annotation,
        suppressor=suppressor,
        road_roi=road_roi,
    )
