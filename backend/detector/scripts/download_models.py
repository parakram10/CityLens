from __future__ import annotations

import argparse
import shutil
import urllib.request
from pathlib import Path

from huggingface_hub import hf_hub_download

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = PROJECT_ROOT / "models"

MODEL_SOURCES = {
    # Default compatible roadside/street litter detector used by config.yaml.
    # YOLOv8n, one class: Litter. Model card says plastic litter, bags, bottles.
    "litter_yolov8n_esapzoi": {
        "repo_id": "esapzoi/litter-detection-yolov8",
        "filename": "best.pt",
        "target": MODELS_DIR / "litter_yolov8n_esapzoi_best.pt",
    },
    # Larger YOLOv8 litter detector. Preferred active litter model in config.yaml.
    "litter_yolov8m_aryanshh": {
        "repo_id": "aryanshh/litter-detector-yolov8",
        "filename": "litter_best.pt",
        "target": MODELS_DIR / "litter_yolov8m_aryanshh_best.pt",
    },
    # Default street/roadside litter detector used by config.yaml.
    # pLitterStreet YOLOv5l, AP50 0.77 in the project README.
    "plitter_street_yolov5l": {
        "url": "https://github.com/gicait/pLitter/releases/download/v0.0.0-street/pLitterStreet_YOLOv5l.pt",
        "target": MODELS_DIR / "plitter_street_yolov5lu.pt",
    },
    # Previous waste detector kept as an alternative.
    # YOLOv8s @ 50 epochs from Shi181a/garbage-ai.
    "garbage_ai_yolov8s_50ep": {
        "repo_id": "Shi181a/garbage-ai",
        "repo_type": "space",
        "filename": "models/combined_v8s_50ep_best.pt",
        "target": MODELS_DIR / "garbage_ai_combined_v8s_50ep_best.pt",
    },
    # Default RDD2022 pothole/road-damage detector used by config.yaml.
    # Keep class D40/pothole in config.yaml.
    "rdd2022_yolo12m": {
        "repo_id": "SreekarAditya/yolo-rdd2022-benchmark",
        "filename": "yolo-rdd2022-benchmark/yolo12m_seed0_best.pt",
        "target": MODELS_DIR / "rdd2022_yolo12m_seed0_best.pt",
    },
    # High-resolution RDD2022 companion model for smaller road defects.
    "rdd2022_yolo12s_800px": {
        "repo_id": "SreekarAditya/yolo-rdd2022-benchmark",
        "filename": "yolo-rdd2022-benchmark/yolo12s_800px_seed0_best.pt",
        "target": MODELS_DIR / "rdd2022_yolo12s_800px_seed0_best.pt",
    },
    # Previous pothole detector kept as an alternative.
    "pothole_peterhdd": {
        "repo_id": "peterhdd/pothole-detection-yolov8",
        "filename": "best.pt",
        "target": MODELS_DIR / "pothole_yolov8s.pt",
    },
    # Previous waste detector kept as an alternative.
    "waste_hrutik": {
        "repo_id": "HrutikAdsare/waste-detection-yolov8",
        "filename": "best.pt",
        "target": MODELS_DIR / "waste_yolov8.pt",
    },
    # Alternative waste detector with 12 classes including trash/plastic/paper/metal/glass.
    "waste_kendrick_12cls": {
        "repo_id": "kendrickfff/waste-classification-yolov8-ken",
        "filename": "yolov8n-waste-12cls-best.pt",
        "target": MODELS_DIR / "waste_yolov8_12cls.pt",
    },
}

DEFAULT_MODELS = ["litter_yolov8m_aryanshh", "rdd2022_yolo12m", "rdd2022_yolo12s_800px"]


def download_model(key: str, force: bool = False) -> Path:
    spec = MODEL_SOURCES[key]
    target = Path(spec["target"])
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and not force:
        print(f"Already exists: {target}")
        return target

    if "url" in spec:
        print(f"Downloading {key} from {spec['url']}")
        urllib.request.urlretrieve(spec["url"], target)
    else:
        print(f"Downloading {key} from {spec['repo_id']}:{spec['filename']}")
        cached = hf_hub_download(
            repo_id=spec["repo_id"],
            filename=spec["filename"],
            repo_type=spec.get("repo_type"),
        )
        shutil.copyfile(cached, target)
    print(f"Saved: {target}")
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description="Download YOLO weights for the civic issue detector.")
    parser.add_argument(
        "--all",
        action="store_true",
        help="Download the default models used by config.yaml.",
    )
    parser.add_argument(
        "--include-alternatives",
        action="store_true",
        help="With --all, also download alternative public model weights.",
    )
    parser.add_argument(
        "--model",
        action="append",
        choices=sorted(MODEL_SOURCES.keys()),
        help="Download a specific model key. Can be repeated.",
    )
    parser.add_argument("--force", action="store_true", help="Overwrite existing files.")
    args = parser.parse_args()

    selected: list[str] = []
    if args.all:
        selected.extend(DEFAULT_MODELS)
        if args.include_alternatives:
            selected.extend([k for k in MODEL_SOURCES if k not in selected])
    if args.model:
        selected.extend(args.model)
    if not selected:
        selected = DEFAULT_MODELS

    for key in dict.fromkeys(selected):
        download_model(key, force=args.force)

    print("Done. Run a test with:")
    print("  python -m civic_issue_detector --source path/to/video.mp4 --max-frames 50")


if __name__ == "__main__":
    main()
