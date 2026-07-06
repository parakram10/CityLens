"""litter_studio - end-to-end litter model fine-tuning for the civic issue detector.

One small tool that takes you from raw video to a fine-tuned YOLO model that drops
straight into config.yaml. Pipeline (run the steps in order):

    1) extract   video(s)            -> dataset/images/*.jpg
    2) label     dataset/images      -> dataset/labels/*.txt  (draw garbage boxes / mark clean)
    3) split     dataset             -> train/val split + data.yaml
    4) train     dataset/data.yaml   -> runs/detect/<name>/weights/best.pt
    5) export    <run>               -> models/litter_finetuned.pt + config.yaml block

Detection, not classification: you draw a box around each piece/pile of garbage.
A frame with NO garbage is marked "clean" (key: k) and becomes a negative example -
those are what stop cars, stalls and boards being flagged as litter.

Examples:
    python scripts/litter_studio.py extract /path/vid1.mp4 --stride 15
    python scripts/litter_studio.py label dataset/images
    python scripts/litter_studio.py split
    python scripts/litter_studio.py train --epochs 100
    python scripts/litter_studio.py export
"""

from __future__ import annotations

import argparse
import random
import shutil
import sys
from pathlib import Path

import cv2

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp"}
DATASET = PROJECT_ROOT / "dataset"
CLASS_NAME = "garbage"
WINDOW = "litter_studio  |  drag=box  n/b=next/back  u=undo  c=clear  k=clean(neg)  q=quit"


def _auto_device() -> str | int:
    try:
        import torch

        if torch.cuda.is_available():
            return 0
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


# --------------------------------------------------------------------------------------
# 1) EXTRACT
# --------------------------------------------------------------------------------------
def cmd_extract(args: argparse.Namespace) -> None:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
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
            cv2.imwrite(str(out / f"{stem}_{i:06d}.jpg"), fr)
            saved += 1
            total += 1
        cap.release()
        print(f"{vpath}: saved {saved} frames")
    print(f"\nExtracted {total} frames to {out}")
    print(f"Next: python scripts/litter_studio.py label {out}")


# --------------------------------------------------------------------------------------
# 2) LABEL  (OpenCV bounding-box annotator)
# --------------------------------------------------------------------------------------
MAX_W, MAX_H = 1500, 850


def _label_path(labels_dir: Path, img_path: Path) -> Path:
    return labels_dir / f"{img_path.stem}.txt"


def _load_labels(path: Path, w: int, h: int) -> tuple[list[list[int]], bool]:
    """Return (boxes_xyxy_px, clean). Empty file = clean negative; missing = unlabeled."""
    if not path.exists():
        return [], False
    text = path.read_text().strip()
    if not text:
        return [], True
    boxes = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        _, cx, cy, bw, bh = parts[:5]
        cx, cy, bw, bh = float(cx), float(cy), float(bw), float(bh)
        x1 = int((cx - bw / 2) * w); y1 = int((cy - bh / 2) * h)
        x2 = int((cx + bw / 2) * w); y2 = int((cy + bh / 2) * h)
        boxes.append([x1, y1, x2, y2])
    return boxes, False


def _save_labels(path: Path, boxes: list[list[int]], clean: bool, w: int, h: int) -> None:
    if boxes:
        lines = []
        for x1, y1, x2, y2 in boxes:
            x1, x2 = sorted((max(0, min(w, x1)), max(0, min(w, x2))))
            y1, y2 = sorted((max(0, min(h, y1)), max(0, min(h, y2))))
            if x2 - x1 < 3 or y2 - y1 < 3:
                continue
            cx = ((x1 + x2) / 2) / w; cy = ((y1 + y2) / 2) / h
            bw = (x2 - x1) / w; bh = (y2 - y1) / h
            lines.append(f"0 {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
        path.write_text("\n".join(lines) + "\n")
    elif clean:
        path.write_text("")  # explicit negative
    elif path.exists():
        path.unlink()  # cleared and not marked clean -> back to unlabeled


def cmd_label(args: argparse.Namespace) -> None:
    images_dir = Path(args.images)
    labels_dir = Path(args.labels) if args.labels else images_dir.parent / "labels"
    labels_dir.mkdir(parents=True, exist_ok=True)
    imgs = sorted(p for p in images_dir.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    if not imgs:
        print(f"No images in {images_dir}")
        return

    st = {"i": 0, "boxes": [], "clean": False, "img": None, "disp": None,
          "scale": 1.0, "drawing": False, "p0": None, "p1": None}

    def load(i: int) -> None:
        st["i"] = i % len(imgs)
        img = cv2.imread(str(imgs[st["i"]]))
        st["img"] = img
        h, w = img.shape[:2]
        st["scale"] = min(1.0, MAX_W / w, MAX_H / h)
        st["disp"] = cv2.resize(img, None, fx=st["scale"], fy=st["scale"]) if st["scale"] < 1 else img.copy()
        boxes, clean = _load_labels(_label_path(labels_dir, imgs[st["i"]]), w, h)
        st["boxes"], st["clean"] = boxes, clean
        st["drawing"] = False; st["p0"] = st["p1"] = None

    def save() -> None:
        h, w = st["img"].shape[:2]
        _save_labels(_label_path(labels_dir, imgs[st["i"]]), st["boxes"], st["clean"], w, h)

    def to_img(x: int, y: int) -> tuple[int, int]:
        return int(x / st["scale"]), int(y / st["scale"])

    def on_mouse(event, x, y, flags, _):
        if event == cv2.EVENT_LBUTTONDOWN:
            st["drawing"] = True; st["p0"] = to_img(x, y); st["p1"] = st["p0"]
        elif event == cv2.EVENT_MOUSEMOVE and st["drawing"]:
            st["p1"] = to_img(x, y)
        elif event == cv2.EVENT_LBUTTONUP and st["drawing"]:
            st["drawing"] = False
            x0, y0 = st["p0"]; x1, y1 = to_img(x, y)
            if abs(x1 - x0) > 4 and abs(y1 - y0) > 4:
                st["boxes"].append([min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)])
                st["clean"] = False

    cv2.namedWindow(WINDOW)
    cv2.setMouseCallback(WINDOW, on_mouse)
    load(args.start)
    print("Controls: drag=draw box | n/space=next | b=back | u=undo | c=clear | "
          "k=mark clean(negative) | q=save+quit")

    while True:
        disp = st["disp"].copy()
        s = st["scale"]
        for x1, y1, x2, y2 in st["boxes"]:
            cv2.rectangle(disp, (int(x1 * s), int(y1 * s)), (int(x2 * s), int(y2 * s)), (0, 220, 0), 2)
        if st["drawing"] and st["p0"] and st["p1"]:
            (ax, ay), (bx, by) = st["p0"], st["p1"]
            cv2.rectangle(disp, (int(ax * s), int(ay * s)), (int(bx * s), int(by * s)), (0, 255, 255), 1)
        labeled = sum(1 for p in imgs if _label_path(labels_dir, p).exists())
        tag = "CLEAN(neg)" if (st["clean"] and not st["boxes"]) else f"{len(st['boxes'])} box"
        hud = f"[{st['i']+1}/{len(imgs)}] {imgs[st['i']].name}  |  {tag}  |  labeled {labeled}/{len(imgs)}"
        cv2.rectangle(disp, (0, 0), (disp.shape[1], 24), (0, 0, 0), -1)
        cv2.putText(disp, hud, (6, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.imshow(WINDOW, disp)

        k = cv2.waitKey(20) & 0xFF
        if k in (ord("n"), ord(" "), 83):
            save(); load(st["i"] + 1)
        elif k in (ord("b"), 81):
            save(); load(st["i"] - 1)
        elif k == ord("u") and st["boxes"]:
            st["boxes"].pop()
        elif k == ord("c"):
            st["boxes"] = []
        elif k == ord("k"):
            st["boxes"] = []; st["clean"] = True
        elif k in (ord("q"), 27):
            save(); break

    cv2.destroyAllWindows()
    pos = sum(1 for p in imgs if (_label_path(labels_dir, p).read_text().strip() if _label_path(labels_dir, p).exists() else ""))
    neg = sum(1 for p in imgs if _label_path(labels_dir, p).exists() and not _label_path(labels_dir, p).read_text().strip())
    print(f"\nSaved. positives(with boxes)={pos}  negatives(clean)={neg}  labeled={pos+neg}/{len(imgs)}")
    print("Next: python scripts/litter_studio.py split")


# --------------------------------------------------------------------------------------
# 3) SPLIT
# --------------------------------------------------------------------------------------
def cmd_split(args: argparse.Namespace) -> None:
    root = Path(args.dataset)
    images_dir = root / "images"
    labels_dir = root / "labels"
    if not images_dir.exists():
        print(f"No {images_dir}. Run extract + label first.")
        return
    labeled = [p for p in sorted(images_dir.iterdir())
               if p.suffix.lower() in IMAGE_EXTS and _label_path(labels_dir, p).exists()]
    if not labeled:
        print("No labeled images found. Label some frames first.")
        return
    rng = random.Random(args.seed)
    rng.shuffle(labeled)
    n_val = max(1, int(len(labeled) * args.val_ratio))
    val, train = labeled[:n_val], labeled[n_val:]

    for sub in ("images/train", "images/val", "labels/train", "labels/val"):
        d = root / sub
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)

    def place(items, split):
        for img in items:
            shutil.copy2(img, root / "images" / split / img.name)
            shutil.copy2(_label_path(labels_dir, img), root / "labels" / split / f"{img.stem}.txt")

    place(train, "train"); place(val, "val")
    data_yaml = root / "data.yaml"
    data_yaml.write_text(
        f"path: {root.resolve()}\n"
        f"train: images/train\n"
        f"val: images/val\n"
        f"names:\n  0: {CLASS_NAME}\n"
    )
    print(f"Split: {len(train)} train / {len(val)} val. Wrote {data_yaml}")
    print(f"Next: python scripts/litter_studio.py train --data {data_yaml}")


# --------------------------------------------------------------------------------------
# 4) TRAIN
# --------------------------------------------------------------------------------------
def cmd_train(args: argparse.Namespace) -> None:
    from ultralytics import YOLO

    data = Path(args.data)
    if not data.exists():
        print(f"data.yaml not found: {data}. Run split first.")
        return
    device = _auto_device() if args.device == "auto" else args.device
    print(f"Training {args.model} on {data} | device={device} | epochs={args.epochs} "
          f"imgsz={args.imgsz} batch={args.batch} workers={args.workers}")
    print("(If the process is 'killed', you are out of memory - lower --batch (e.g. 2), "
          "--imgsz (e.g. 512), or use --model yolo11n.pt. On <=8GB Macs, cloud GPU is easier.)")
    model = YOLO(args.model)
    model.train(data=str(data), epochs=args.epochs, imgsz=args.imgsz, device=device,
                batch=args.batch, patience=args.patience, name=args.name,
                workers=args.workers, cache=False,
                project=str(PROJECT_ROOT / "runs" / "detect"))
    best = PROJECT_ROOT / "runs" / "detect" / args.name / "weights" / "best.pt"
    print(f"\nDone. Best weights: {best}")
    print(f"Next: python scripts/litter_studio.py export --weights {best}")


# --------------------------------------------------------------------------------------
# 5) EXPORT
# --------------------------------------------------------------------------------------
def _find_latest_best() -> Path | None:
    runs = list((PROJECT_ROOT / "runs" / "detect").glob("*/weights/best.pt"))
    return max(runs, key=lambda p: p.stat().st_mtime) if runs else None


def cmd_export(args: argparse.Namespace) -> None:
    src = Path(args.weights) if args.weights else _find_latest_best()
    if not src or not src.exists():
        print("No trained weights found. Pass --weights runs/detect/<name>/weights/best.pt")
        return
    dst = PROJECT_ROOT / "models" / "litter_finetuned.pt"
    shutil.copy2(src, dst)
    print(f"Copied {src}  ->  {dst}\n")
    print("Add this block under `models:` in config.yaml (and set enabled:false on")
    print("litter_yolov8m_aryanshh so your model replaces it):\n")
    print(f"""  - name: litter_finetuned
    enabled: true
    weights: models/litter_finetuned.pt
    issue_group: waste_litter
    default_issue_type: garbage
    confidence_threshold: 0.35
    iou_threshold: 0.45
    image_size: {args.imgsz}
    include_classes: [{CLASS_NAME}]
    min_center_y_ratio: 0.20
    min_bottom_y_ratio: 0.30
    max_box_area_ratio: 0.40
    max_box_width_ratio: 0.65
    max_box_height_ratio: 0.60
    tile_inference: false
    class_map:
      {CLASS_NAME}: garbage""")
    print("\nThen verify: python scripts/diagnose_image.py <a litter frame> --device mps --save check.jpg")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("extract", help="Split video(s) into frames.")
    p.add_argument("videos", nargs="+")
    p.add_argument("--out", default=str(DATASET / "images"))
    p.add_argument("--stride", type=int, default=15)
    p.add_argument("--max-per-video", type=int, default=500)
    p.set_defaults(func=cmd_extract)

    p = sub.add_parser("label", help="Draw garbage boxes / mark clean frames.")
    p.add_argument("images", nargs="?", default=str(DATASET / "images"))
    p.add_argument("--labels", default=None)
    p.add_argument("--start", type=int, default=0, help="Start at this image index.")
    p.set_defaults(func=cmd_label)

    p = sub.add_parser("split", help="Train/val split + data.yaml.")
    p.add_argument("--dataset", default=str(DATASET))
    p.add_argument("--val-ratio", type=float, default=0.2)
    p.add_argument("--seed", type=int, default=0)
    p.set_defaults(func=cmd_split)

    p = sub.add_parser("train", help="Fine-tune a YOLO model.")
    p.add_argument("--data", default=str(DATASET / "data.yaml"))
    p.add_argument("--model", default="yolo11n.pt", help="yolo11n=lightest (good on 8GB); yolo11s=better if RAM allows.")
    p.add_argument("--epochs", type=int, default=100)
    p.add_argument("--imgsz", type=int, default=640, help="Lower (512) if the run is killed for memory.")
    p.add_argument("--batch", type=int, default=4, help="Lower (2) if the run is killed for memory.")
    p.add_argument("--patience", type=int, default=30)
    p.add_argument("--name", default="litter_ft")
    p.add_argument("--device", default="auto")
    p.add_argument("--workers", type=int, default=2, help="Dataloader workers; keep low on limited RAM.")
    p.set_defaults(func=cmd_train)

    p = sub.add_parser("export", help="Copy best.pt to models/ + print config block.")
    p.add_argument("--weights", default=None)
    p.add_argument("--imgsz", type=int, default=1280)
    p.set_defaults(func=cmd_export)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
