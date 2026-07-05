from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ModelSpec:
    name: str
    weights: str
    enabled: bool = True
    issue_group: str = "civic_issue"
    default_issue_type: str = "civic_issue"
    confidence_threshold: float = 0.25
    iou_threshold: float = 0.45
    image_size: int = 640
    # Ultralytics task hint. Required for exported formats (e.g. ONNX) whose task
    # cannot always be inferred from the file. None lets Ultralytics auto-detect.
    task: str | None = None
    include_classes: list[str] = field(default_factory=list)
    class_map: dict[str, str] = field(default_factory=dict)
    min_center_y_ratio: float = 0.0
    min_bottom_y_ratio: float = 0.0
    max_box_area_ratio: float = 1.0
    max_box_width_ratio: float = 1.0
    max_box_height_ratio: float = 1.0
    tile_inference: bool = False
    tile_cols: int = 1
    tile_rows: int = 1
    tile_overlap_ratio: float = 0.10
    tile_min_y_ratio: float = 0.0
    tile_max_y_ratio: float = 1.0


@dataclass
class SuppressorConfig:
    """Class-agnostic false-positive filter.

    Runs a stock COCO detector once per frame and drops civic-issue detections
    that sit on top of everyday objects (people, vehicles, animals, ...). This
    is what stops people and two-wheelers being flagged as litter.
    """

    enabled: bool = False
    weights: str = "yolo11n.pt"
    task: str | None = None
    confidence_threshold: float = 0.35
    image_size: int = 640
    # COCO class names whose regions should suppress overlapping issue boxes.
    suppress_classes: list[str] = field(
        default_factory=lambda: [
            "person",
            "bicycle",
            "motorcycle",
            "car",
            "bus",
            "truck",
            "train",
            "dog",
            "cat",
            "cow",
            "horse",
        ]
    )
    # An issue box is dropped when this fraction of its area overlaps a
    # suppressor box (intersection / issue_area) - i.e. litter sitting on a person.
    containment_threshold: float = 0.45
    # Also drop when the issue box COVERS this fraction of a suppressor box
    # (intersection / suppressor_area) - i.e. a big "litter" box wrapping a car.
    vehicle_cover_threshold: float = 0.60
    # Only filter these issue groups. Potholes/road defects are left untouched.
    apply_to_issue_groups: list[str] = field(default_factory=lambda: ["waste_litter"])


@dataclass
class RoadROIConfig:
    """Road-region-of-interest mask.

    Litter is only accepted when its ground-contact point falls inside a polygon
    covering the road/verge. This keeps ground-level litter on the left and right
    while rejecting anything above the road line (name boards, buildings, trees)
    regardless of confidence. Polygon points are normalized (x, y in 0..1).
    """

    enabled: bool = False
    # Default trapezoid: from mid-frame down, widening to the full width at the
    # bottom. Tune per camera once you see the annotated overlay.
    polygon: list[list[float]] = field(
        default_factory=lambda: [[0.15, 0.45], [0.85, 0.45], [1.0, 1.0], [0.0, 1.0]]
    )
    apply_to_issue_groups: list[str] = field(default_factory=lambda: ["waste_litter"])
    # Which point of the box must be inside the polygon: "bottom_center" (where
    # litter touches the ground) or "center".
    test_point: str = "bottom_center"
    # Draw the ROI outline on the annotated video/frames to help tuning.
    draw: bool = True


@dataclass
class ProcessingConfig:
    frame_stride: int = 1
    crop_padding_ratio: float = 0.08
    save_annotated_video: bool = True
    save_detection_crops: bool = True
    save_screen_grabs: bool = True
    cross_model_nms: bool = True
    cross_model_nms_iou: float = 0.70
    skip_similar_frames: bool = True
    similar_frame_threshold: float = 3.5
    similar_frame_downscale_width: int = 160
    max_similar_frame_skips: int = 8
    persist_detections_between_inferences: bool = True
    max_persisted_detection_frames: int = 0
    temporal_dedupe: bool = True
    temporal_dedupe_iou: float = 0.35
    temporal_dedupe_grid_cols: int = 8
    temporal_dedupe_grid_rows: int = 6
    temporal_dedupe_ttl_frames: int = 300
    # Motion-tolerant object tracking so one physical issue = one record even as
    # the camera moves. When enabled it supersedes the static temporal_dedupe.
    track_issues: bool = True
    # A detection matches an existing track if IoU >= track_iou OR the normalized
    # centroid distance <= the (motion-growing) distance gate.
    track_iou: float = 0.30
    track_center_dist_ratio: float = 0.12
    # Distance gate grows by this much per inference frame since the track was
    # last seen, to tolerate fast camera motion / frame striding.
    track_motion_gate_growth: float = 0.04
    # Drop a track after this many inference frames without a match (0 = never).
    track_max_age_frames: int = 45
    # A track must be seen on at least this many inference frames before it is
    # emitted as an issue. 1 keeps everything; 2+ filters single-frame flukes.
    track_min_hits: int = 2


@dataclass
class AnnotationConfig:
    box_thickness: int = 2
    font_scale: float = 0.60
    show_raw_class: bool = True
    show_model_name: bool = False
    # Prefix each box with its stable issue id (e.g. "#12"). Makes the
    # one-issue-one-id de-duplication visible in the annotated video.
    show_issue_id: bool = True


@dataclass
class AppConfig:
    models: list[ModelSpec]
    processing: ProcessingConfig = field(default_factory=ProcessingConfig)
    annotation: AnnotationConfig = field(default_factory=AnnotationConfig)
    suppressor: SuppressorConfig = field(default_factory=SuppressorConfig)
    road_roi: RoadROIConfig = field(default_factory=RoadROIConfig)


@dataclass
class Detection:
    detection_id: str
    frame_index: int
    timestamp_sec: float
    model_name: str
    issue_group: str
    issue_type: str
    raw_class: str
    class_id: int
    confidence: float
    confidence_pct: float
    bbox_xyxy: list[int]
    bbox_xywh: list[int]
    bbox_normalized_xyxy: list[float]
    # Stable id of the physical issue this detection belongs to (from tracking).
    issue_id: str | None = None
    crop_path: str | None = None
    screen_grab_path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "detection_id": self.detection_id,
            "issue_id": self.issue_id,
            "frame_index": self.frame_index,
            "timestamp_sec": round(float(self.timestamp_sec), 3),
            "model_name": self.model_name,
            "issue_group": self.issue_group,
            "issue_type": self.issue_type,
            "raw_class": self.raw_class,
            "class_id": int(self.class_id),
            "confidence": round(float(self.confidence), 5),
            "confidence_pct": round(float(self.confidence_pct), 2),
            "bbox_xyxy": [int(v) for v in self.bbox_xyxy],
            "bbox_xywh": [int(v) for v in self.bbox_xywh],
            "bbox_normalized_xyxy": [round(float(v), 6) for v in self.bbox_normalized_xyxy],
            "crop_path": self.crop_path,
            "screen_grab_path": self.screen_grab_path,
        }
