from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .schema import Detection


def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def relpath(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def save_json(path: str | Path, payload: dict[str, Any]) -> None:
    with Path(path).open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)


def safe_crop(frame: np.ndarray, bbox_xyxy: list[int], padding_ratio: float) -> np.ndarray:
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = bbox_xyxy
    box_w = max(1, x2 - x1)
    box_h = max(1, y2 - y1)
    pad_x = int(round(box_w * padding_ratio))
    pad_y = int(round(box_h * padding_ratio))
    cx1 = max(0, x1 - pad_x)
    cy1 = max(0, y1 - pad_y)
    cx2 = min(w - 1, x2 + pad_x)
    cy2 = min(h - 1, y2 + pad_y)
    crop = frame[cy1:cy2, cx1:cx2]
    if crop.size == 0:
        return frame[max(0, y1):max(1, y2), max(0, x1):max(1, x2)]
    return crop


def save_detection_crop(
    frame: np.ndarray,
    det: Detection,
    crop_dir: Path,
    output_root: Path,
    padding_ratio: float,
) -> str | None:
    crop = safe_crop(frame, det.bbox_xyxy, padding_ratio)
    if crop.size == 0:
        return None
    filename = f"{det.detection_id}_{det.issue_type}_{int(round(det.confidence_pct))}pct.jpg"
    out_path = crop_dir / filename
    cv2.imwrite(str(out_path), crop)
    return relpath(out_path, output_root)


def save_issue_crop(
    frame: np.ndarray,
    det: Detection,
    crop_dir: Path,
    output_root: Path,
    padding_ratio: float,
) -> str | None:
    """Save one crop per physical issue, using a stable filename so the best
    frame overwrites earlier ones for the same ``issue_id``."""
    crop = safe_crop(frame, det.bbox_xyxy, padding_ratio)
    if crop.size == 0:
        return None
    issue_id = det.issue_id or det.detection_id
    out_path = crop_dir / f"{issue_id}_{det.issue_type}.jpg"
    cv2.imwrite(str(out_path), crop)
    return relpath(out_path, output_root)


def remove_output_file(rel_path: str | None, output_root: Path) -> None:
    """Delete a previously written output file referenced by a run-relative path."""
    if not rel_path:
        return
    target = output_root / rel_path
    try:
        target.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass
