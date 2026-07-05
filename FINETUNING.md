# Fine-tuning a litter model on your own footage

## Quick path: the `litter_studio` tool (all-in-one)

One script does the whole pipeline — no external labeling app needed:

```bash
# 1) video -> frames
python scripts/litter_studio.py extract /Users/you/Downloads/vid1.mp4 --stride 15
# 2) label: drag a box around each garbage patch; press k on a clean frame (negative)
python scripts/litter_studio.py label
#    keys: drag=box  n/space=next  b=back  u=undo  c=clear  k=clean(negative)  q=quit
# 3) train/val split + data.yaml
python scripts/litter_studio.py split
# 4) fine-tune (auto-uses the Apple GPU)
python scripts/litter_studio.py train --epochs 100
# 5) copy weights into models/ and print the config.yaml block to paste
python scripts/litter_studio.py export
```

Labeling rules still apply (below): box only road/verge garbage, and mark plenty of
clean shop/stall/board frames as negatives (key `k`). Optionally seed draft boxes
first with `scripts/prelabel.py` — `litter_studio label` will load and let you
correct them. The manual/tool-based route below is the alternative if you prefer
Roboflow/labelImg.

---


The pretrained litter/garbage models miss real roadside litter and/or fire on
clutter (verified on `vid1.mp4`). This is a model-capability limit — the reliable
fix is to fine-tune a small YOLO model on a few hundred labeled frames of your own
dashcam footage. Everything else in this app (potholes, tracking, ROI, dedup,
suppressor) stays exactly the same; you only swap the litter weights.

Rough effort: ~2–4 h labeling + ~1–2 h training on a GPU. Target: **mAP is
secondary — what matters is that it boxes real piles/scattered litter and ignores
shops, boards, trees.**

## 1. Collect frames

Aim for **~400–800 images** spanning the conditions you care about: piles,
scattered litter, wet roads, shade, plus plenty of **clean** street scenes (shops,
name boards, parked two-wheelers, trees) as *hard negatives* so the model learns
what is NOT litter.

```bash
# Every 15th frame across your videos:
python scripts/extract_frames.py /Users/you/Downloads/vid1.mp4 vid2.mp4 --stride 15 --out dataset/images

# Or bias toward litter frames (only where the current model already fires):
python scripts/extract_frames.py /Users/you/Downloads/vid1.mp4 --stride 10 --litter-only --out dataset/images
```

Then manually add ~100–150 clean/negative frames (no boxes) so false positives
are trained out.

## 2. Label

Use any tool that exports **YOLO format**: [Roboflow](https://roboflow.com)
(easiest, has auto-split + augmentation), CVAT, or Label Studio.

- Keep the class set small. Recommended: `litter`, `garbage_pile` (or just
  `litter` if you don't need the distinction).
- Draw tight boxes on **road/verge litter only**. Do NOT box litter on rooftops,
  inside shops, or on vehicles — those are out of scope and hurt precision.
- **Bootstrap (recommended):** generate draft boxes, then correct them —
  much faster than drawing from scratch:
  ```bash
  python scripts/prelabel.py dataset/images --conf 0.10 --roi
  ```
  This writes `dataset/labels/*.txt` (YOLO format) + `classes.txt`. Open in
  **labelImg** (`pip install labelImg`, save format = YOLO) and correct: delete
  wrong boxes (cars, stalls, people, walls), tighten loose boxes, add missed
  litter. The drafts contain the model's mistakes — your review is the point.
- **Hard negatives:** include ~20-30% clean frames (shops, stalls, parked bikes,
  boards) with EMPTY label files. This is what trains out the false positives.
- Optional: augment with the public **TACO** dataset (trash in context) or a
  street-litter set to add volume, but your own footage matters most.

Export as YOLOv8/YOLO format → you get `images/`, `labels/`, and a `data.yaml`:

```yaml
# data.yaml
path: /abs/path/to/dataset
train: images/train
val: images/val
names:
  0: litter
  1: garbage_pile
```

## 3. Train

Use the same `ultralytics` package already installed. Start from a small pretrained
checkpoint (`yolo11s.pt` or `yolo11m.pt`):

```bash
# On this Mac (Apple GPU):
yolo detect train model=yolo11s.pt data=dataset/data.yaml epochs=120 imgsz=1280 \
  device=mps batch=8 patience=30 name=litter_ft

# On an NVIDIA GPU (Colab / cloud) — much faster:
yolo detect train model=yolo11m.pt data=dataset/data.yaml epochs=150 imgsz=1280 \
  device=0 batch=16 mosaic=1.0 name=litter_ft
```

Best weights land in `runs/detect/litter_ft/weights/best.pt`.

## 4. Evaluate

```bash
yolo detect val model=runs/detect/litter_ft/weights/best.pt data=dataset/data.yaml device=mps
```

Then eyeball real frames with the app's own diagnostic (this reflects the full
pipeline — ROI, filters, tracker):

```bash
cp runs/detect/litter_ft/weights/best.pt models/litter_finetuned.pt
python scripts/diagnose_image.py some_litter_frame.jpg --device mps --save check.jpg
```

## 5. Plug it into the app

Add a model block in `config.yaml` (and disable the pretrained litter models):

```yaml
  - name: litter_finetuned
    enabled: true
    weights: models/litter_finetuned.pt
    issue_group: waste_litter
    default_issue_type: roadside_litter
    confidence_threshold: 0.35        # your model will justify a higher bar
    iou_threshold: 0.45
    image_size: 1280
    include_classes: [litter, garbage_pile]
    min_center_y_ratio: 0.20
    min_bottom_y_ratio: 0.30
    max_box_area_ratio: 0.40
    max_box_width_ratio: 0.65
    max_box_height_ratio: 0.60
    tile_inference: false
    class_map:
      litter: roadside_litter
      garbage_pile: garbage_pile
```

Keep `road_roi`, `suppressor`, and `track_issues` on — they complement the model.
Re-run and compare against the pretrained baseline on the same clip.

## Why this works when tuning didn't

Thresholds, tiling, and the ROI can only reshape what a model *already outputs*.
If the model was never trained on Indian roadside garbage piles, it won't emit a
box no matter the settings. A few hundred labeled frames from your exact camera and
scenes is what closes that gap — and the hard-negative frames (shops/boards/trees)
are what remove the false positives that no geometric filter can catch.
