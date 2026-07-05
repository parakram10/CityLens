# Civic Issue Video Detector

Local Python project for a hackathon demo that accepts a video file, webcam index, RTSP stream, or HTTP video stream, runs YOLO inference, and outputs:

- `annotated.mp4` with bounding boxes around civic issues
- `detections.json` with detection type, confidence percentage, frame timestamp, and bounding boxes
- `screen_grabs/` containing annotated frame grabs when an issue is detected
- `crops/` containing cropped images of each detected issue

The annotation label shows the inference type and confidence percentage, for example:

```text
Pothole 82.4%
Litter 74.8% (Plastic)
Garbage 68.2% (Organic waste)
```

## What it detects by default

The default config runs several pretrained YOLO models plus a false-positive filter:

1. Litter / garbage: a single-class litter detector (`litter_yolov8m_aryanshh`).
2. Potholes / road defects: `SreekarAditya/yolo-rdd2022-benchmark`, `yolo12m_seed0_best.pt`
3. High-resolution pothole backup: same benchmark, `yolo12s_800px_seed0_best.pt`
4. A **COCO suppressor** (`yolo11n.pt`) that removes litter boxes overlapping
   people, two-wheelers, vehicles, and animals (see below).
5. A **road-region ROI mask** that only accepts litter on the road/verge, so
   name boards, shopfronts and buildings above the road line are never flagged.

For RDD2022, the config keeps only the pothole class. You can add more models in
`config.yaml`, such as an Indian-road-specific detector for open drains,
waterlogging, broken roads, manholes, or sewer covers.

## Litter detection quality (important, measured)

The litter/garbage side is limited by the available pretrained models, verified on
real Bengaluru dashcam footage:

- `litter_yolov8m_aryanshh` (default) is **precise but low-recall** — with the ROI
  mask it produces almost no false positives, but it misses a lot of real litter,
  including some obvious roadside piles.
- `garbage_ai_yolov8s_50ep` has **higher recall but fires on clutter** (shop
  interiors, parked two-wheelers, walls, even trees). Toggle it in `config.yaml`
  if you prefer recall over precision.
- `plitter_street_yolov5l` (pLitterStreet) **does not work**: the YOLOv5→ONNX
  export loads but Ultralytics mis-parses its output (garbage boxes). Disabled.

There is no threshold/tiling setting that makes these models reliably detect
scattered Indian street litter — that is a model-capability ceiling. For
production-grade litter detection, fine-tune a YOLO model on a few hundred
labeled frames of your own footage (or a dataset like TACO). The potholes, issue
tracking, ROI, and de-duplication pipeline are all solid; litter recall is the
weak link and needs a better-trained model, not more tuning.

## One issue = one record (issue tracking)

A moving camera re-detects the same pothole/litter pile on every frame, and the
box drifts across the frame, so naive de-duplication counts one issue many times.
`processing.track_issues` (on by default) associates detections across frames
using a **motion-tolerant tracker** (matches on IoU *or* a centroid-distance gate
that grows with camera motion) and assigns each physical issue a stable
`issue_id`. The result:

- The annotated video shows a stable `#id` on each box across frames.
- Exactly **one crop + one screen grab per issue** (its highest-confidence frame).
- `detections.json` contains an `issues` list — one entry per physical issue —
  with `detection_count`, `peak_confidence_pct`, and first/last frame + timestamp.
- `track_min_hits` (default 2) drops single-frame flukes for free.

Key knobs in `config.yaml`:

```yaml
processing:
  track_issues: true
  track_iou: 0.30              # IoU match threshold
  track_center_dist_ratio: 0.12   # centroid-distance gate (normalized)
  track_motion_gate_growth: 0.04  # gate growth per frame of camera motion
  track_max_age_frames: 45    # forget a track after this many unseen frames
  track_min_hits: 2           # frames an issue must appear on to be reported
```

## Reducing false positives (COCO suppressor)

Single-class litter models tend to fire on colorful/textured regions — people,
riders on two-wheelers, shopfronts, hoardings. The `suppressor` runs a stock
COCO detector once per frame and **drops any litter/garbage box that sits on top
of** a person, bicycle, motorcycle, car, bus, truck, or animal:

```yaml
suppressor:
  enabled: true
  weights: yolo11n.pt          # ~5 MB, auto-downloaded on first run
  containment_threshold: 0.45  # drop if this fraction of the box is on a person/vehicle
  suppress_classes: [person, bicycle, motorcycle, car, bus, truck, ...]
  apply_to_issue_groups: [waste_litter]   # potholes are never filtered
```

Shopfronts, name boards, and buildings are not COCO classes — they are handled by
the **road-region ROI mask** below, which rejects anything above the road line.

## Road-region ROI mask

Litter is only accepted when its ground-contact point falls inside a polygon over
the road/verge, so ground-level litter on the left and right is kept while name
boards, buildings, and trees above the road line are rejected at any confidence:

```yaml
road_roi:
  enabled: true
  polygon:                 # normalized (x, y), clockwise; a trapezoid over the road
    - [0.15, 0.45]
    - [0.85, 0.45]
    - [1.0, 1.0]
    - [0.0, 1.0]
  apply_to_issue_groups: [waste_litter]
  test_point: bottom_center
  draw: true               # draws a cyan outline on the video so you can tune it
```

Run once with `draw: true`, watch where the cyan outline sits on your footage, and
adjust the polygon points (raise/lower the top edge, widen/narrow the far end).

## Device / speed

`--device auto` (the default) now picks the best backend automatically: CUDA GPU,
then Apple **MPS** (Metal), else CPU. On Apple Silicon this is ~10x faster than
CPU. Override with `--device mps`, `--device cpu`, or `--device 0`.

## pLitterStreet (does not work)

`scripts/convert_plitter.py` converts the legacy YOLOv5 pLitterStreet weights to
ONNX, but **the result does not work** — Ultralytics mis-parses YOLOv5's ONNX
output and produces garbage detections. The model is disabled in `config.yaml`.
Using pLitterStreet properly requires running it through the `yolov5` detection
code (a separate runtime), which this app does not integrate. The script and
config block are kept only as a record.

## Setup

Use Python 3.10 or newer.

```bash
cd civic_issue_video_detector
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt
```

Download the default model weights:

```bash
python scripts/download_models.py --all
```

Expected downloaded files:

```text
models/garbage_ai_combined_v8s_50ep_best.pt
models/rdd2022_yolo12m_seed0_best.pt
models/rdd2022_yolo12s_800px_seed0_best.pt
```

## Run on a video file

```bash
python -m civic_issue_detector --source path/to/road_video.mp4 --display
```

For a quick smoke test on the first 100 frames:

```bash
python -m civic_issue_detector --source path/to/road_video.mp4 --max-frames 100
```

## Run on webcam

```bash
python -m civic_issue_detector --source 0 --display
```

Press `q` or `Esc` to stop the display window.

## Run on RTSP / IP camera

```bash
python -m civic_issue_detector --source "rtsp://user:password@camera-ip/stream1"
```

## Output folder

Each run creates a timestamped folder under `outputs/`:

```text
outputs/run_YYYYMMDD_HHMMSS/
  annotated.mp4
  detections.json
  summary.json
  screen_grabs/
    frame_000123_t000004_100.jpg
  crops/
    f000123_pothole_yolov8s_00_pothole_82pct.jpg
```

## JSON schema example

With `track_issues` on (default), `detections.json` reports one entry per physical
issue in `issues`, an `issue_summary` with counts, and a `detections` list holding
the single best-frame detection per issue (each carries its `issue_id`):

```json
{
  "source": "road_video.mp4",
  "issue_summary": {
    "unique_issues": 2,
    "by_issue_type": { "pothole": 1, "roadside_litter": 1 }
  },
  "outputs": {
    "annotated_video_path": "annotated.mp4",
    "detections_json_path": "detections.json",
    "screen_grabs_dir": "screen_grabs",
    "crops_dir": "crops"
  },
  "issues": [
    {
      "issue_id": "issue_000001",
      "issue_type": "pothole",
      "issue_group": "road_defect",
      "model_name": "rdd2022_yolo12m",
      "peak_confidence_pct": 82.41,
      "detection_count": 37,
      "first_frame_index": 118,
      "last_frame_index": 205,
      "first_timestamp_sec": 3.93,
      "last_timestamp_sec": 6.83,
      "bbox_xyxy": [211, 390, 386, 461],
      "crop_path": "crops/issue_000001_pothole.jpg",
      "screen_grab_path": "screen_grabs/issue_000001.jpg"
    }
  ],
  "detections": [
    {
      "detection_id": "f000123_rdd2022_yolo12m_00_00",
      "issue_id": "issue_000001",
      "frame_index": 123,
      "timestamp_sec": 4.1,
      "model_name": "rdd2022_yolo12m",
      "issue_group": "road_defect",
      "issue_type": "pothole",
      "confidence_pct": 82.41,
      "bbox_xyxy": [211, 390, 386, 461],
      "crop_path": "crops/issue_000001_pothole.jpg",
      "screen_grab_path": "screen_grabs/issue_000001.jpg"
    }
  ]
}
```

Set `processing.track_issues: false` to fall back to the legacy per-frame
`detections` output with static grid+IoU de-duplication.

## Configuring classes and issue types

Edit `config.yaml` to rename model classes into civic-issue labels.

Example:

```yaml
class_map:
  Plastic: litter
  Paper: litter
  Organic waste: garbage
  pothole: pothole
  drain: open_drain
```

This is what controls the label shown in the video and the `issue_type` field in JSON.

## Add an Indian-road-specific model

If you download or export a YOLO model that detects Indian civic issues like manholes, drains, waterlogging, broken roads, or unclean drains:

1. Place the weights in `models/other_road_defects.pt`.
2. Set `enabled: true` for `other_defects_optional` in `config.yaml`.
3. Update `class_map` to map model classes to your final issue names.

No code changes are required.

## Useful flags

```bash
# Process every 3rd frame for faster inference
python -m civic_issue_detector --source road.mp4 --frame-stride 3

# Compare against no visual similarity skipping
python -m civic_issue_detector --source road.mp4 --no-skip-similar

# Skip visually similar frames more aggressively
python -m civic_issue_detector --source road.mp4 --similar-threshold 6.0

# Force CPU inference
python -m civic_issue_detector --source road.mp4 --device cpu

# Use first GPU
python -m civic_issue_detector --source road.mp4 --device 0

# Save JSON/crops/grabs, but skip annotated video
python -m civic_issue_detector --source road.mp4 --no-video

# Write to a deterministic output folder
python -m civic_issue_detector --source road.mp4 --run-name demo_run
```

## Faster video inference

In addition to `--frame-stride`, `config.yaml` enables `processing.skip_similar_frames` by default. Candidate inference frames are downscaled, converted to grayscale, and compared to the last frame that actually ran inference. If the mean pixel delta is below `similar_frame_threshold`, the detector skips that frame and reuses the last detections only for annotation preview/video output.

The most useful tuning values are:

```yaml
processing:
  frame_stride: 1
  skip_similar_frames: true
  similar_frame_threshold: 3.5
  similar_frame_downscale_width: 160
  max_similar_frame_skips: 8
```

Raise `similar_frame_threshold` to skip more aggressively, lower it to run inference on smaller changes, or set `max_similar_frame_skips` lower if you want more frequent forced refreshes. The RDD models use `confidence_threshold: 0.15` because this benchmark performs better around the 0.10-0.20 range than YOLO's usual 0.25 default.

## Notes for hackathon judging

- Use a short Indian street clip with visible road surface and roadside waste.
- Keep `--display` on during the demo so judges see boxes, issue type, and confidence percentage live.
- Show `detections.json` and `screen_grabs/` after running to demonstrate the data pipeline.
- If GPU memory is tight, disable `rdd2022_yolo12s_800px` in `config.yaml` first; keep GarbageAI and `rdd2022_yolo12m` enabled.
