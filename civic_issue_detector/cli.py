from __future__ import annotations

import argparse
from pathlib import Path

from .config import load_config


def parse_source(value: str) -> str | int:
    if value.isdigit():
        return int(value)
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Detect potholes, garbage, litter, and configured civic defects from video or webcam.",
    )
    parser.add_argument(
        "--source",
        required=True,
        help="Video file, webcam index like 0, RTSP URL, or HTTP video stream URL.",
    )
    parser.add_argument(
        "--config",
        default="config.yaml",
        help="Path to config.yaml.",
    )
    parser.add_argument(
        "--output-dir",
        default="outputs",
        help="Directory where run outputs are created.",
    )
    parser.add_argument(
        "--run-name",
        default=None,
        help="Optional deterministic output subfolder name. Default uses timestamp.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        help="Ultralytics device value: auto, cpu, 0, 0,1, etc.",
    )
    parser.add_argument(
        "--display",
        action="store_true",
        help="Show a live preview window. Press q or Esc to stop.",
    )
    parser.add_argument(
        "--max-frames",
        type=int,
        default=None,
        help="Stop after this many frames. Useful for quick tests.",
    )
    parser.add_argument(
        "--frame-stride",
        type=int,
        default=None,
        help="Override config processing.frame_stride. 1 = every frame, 2 = every other frame.",
    )
    parser.add_argument(
        "--no-skip-similar",
        action="store_true",
        help="Disable visual similarity-based frame skipping.",
    )
    parser.add_argument(
        "--similar-threshold",
        type=float,
        default=None,
        help="Override config processing.similar_frame_threshold. Higher skips more frames.",
    )
    parser.add_argument(
        "--no-video",
        action="store_true",
        help="Do not save annotated.mp4; still saves JSON, crops, and screen grabs.",
    )
    return parser


def main() -> None:
    args = build_parser().parse_args()

    # Import heavy ML/OpenCV dependencies only after argument parsing, so --help works
    # even before pip install -r requirements.txt has been run.
    from .detector import CivicIssueDetector
    from .video import process_video

    project_root = Path(__file__).resolve().parents[1]
    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = project_root / config_path

    config = load_config(config_path)
    if args.frame_stride is not None:
        config.processing.frame_stride = max(1, args.frame_stride)
    if args.no_skip_similar:
        config.processing.skip_similar_frames = False
    if args.similar_threshold is not None:
        config.processing.similar_frame_threshold = max(0.0, args.similar_threshold)

    detector = CivicIssueDetector(
        model_specs=config.models,
        project_root=project_root,
        device=args.device,
        suppressor_config=config.suppressor,
        road_roi_config=config.road_roi,
    )
    process_video(
        source=parse_source(args.source),
        detector=detector,
        config=config,
        output_dir=args.output_dir,
        run_name=args.run_name,
        display=args.display,
        max_frames=args.max_frames,
        save_video_override=False if args.no_video else None,
    )


if __name__ == "__main__":
    main()
