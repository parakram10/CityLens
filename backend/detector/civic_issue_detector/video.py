from __future__ import annotations

import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .annotator import draw_detections
from .detector import CivicIssueDetector, bbox_iou, cross_model_nms
from .io_utils import (
    ensure_dir,
    relpath,
    remove_output_file,
    save_detection_crop,
    save_issue_crop,
    save_json,
)
from .schema import AppConfig, Detection
from .tracker import IssueTracker


def _make_run_dir(base_output_dir: str | Path, run_name: str | None = None) -> Path:
    base = ensure_dir(base_output_dir)
    if run_name:
        return ensure_dir(base / run_name)
    stamp = datetime.now().strftime("run_%Y%m%d_%H%M%S")
    return ensure_dir(base / stamp)


def _video_fps(cap: cv2.VideoCapture) -> float:
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    if fps <= 1e-3 or fps > 240:
        return 30.0
    return fps


def _frame_timestamp(cap: cv2.VideoCapture, frame_index: int, fps: float) -> float:
    msec = float(cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0)
    if msec > 0:
        return msec / 1000.0
    return frame_index / fps if fps > 0 else 0.0


def _open_video_writer(path: Path, width: int, height: int, fps: float) -> cv2.VideoWriter:
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(path), fourcc, fps, (width, height))
    if not writer.isOpened():
        raise RuntimeError(f"Could not open video writer: {path}")
    return writer


def _screen_grab_filename(frame_index: int, timestamp_sec: float) -> str:
    safe_time = f"{timestamp_sec:010.3f}".replace(".", "_")
    return f"frame_{frame_index:06d}_t{safe_time}.jpg"


def _frame_signature(frame: np.ndarray, downscale_width: int) -> np.ndarray:
    height, width = frame.shape[:2]
    scale = downscale_width / max(1, width)
    resized_height = max(1, int(round(height * scale)))
    resized = cv2.resize(frame, (downscale_width, resized_height), interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)


def _mean_frame_delta(previous: np.ndarray | None, current: np.ndarray) -> float | None:
    if previous is None:
        return None
    if previous.shape != current.shape:
        return None
    delta = cv2.absdiff(previous, current)
    return float(delta.mean())


# --- Static (camera-fixed) fallback de-duplication -------------------------------
# Used only when processing.track_issues is False. The tracker path below is the
# default and handles moving cameras.


def _detection_grid_cell(det: Detection, grid_cols: int, grid_rows: int) -> tuple[int, int]:
    x1, y1, x2, y2 = det.bbox_normalized_xyxy
    center_x = max(0.0, min(1.0, (x1 + x2) / 2.0))
    center_y = max(0.0, min(1.0, (y1 + y2) / 2.0))
    col = min(grid_cols - 1, int(center_x * grid_cols))
    row = min(grid_rows - 1, int(center_y * grid_rows))
    return col, row


def _prune_recent_detections(
    recent_detections: list[dict[str, Any]],
    frame_index: int,
    ttl_frames: int,
) -> None:
    if ttl_frames <= 0:
        return
    recent_detections[:] = [
        item for item in recent_detections if frame_index - int(item["frame_index"]) <= ttl_frames
    ]


def _is_recent_duplicate(
    det: Detection,
    recent_detections: list[dict[str, Any]],
    grid_cols: int,
    grid_rows: int,
    iou_threshold: float,
) -> bool:
    col, row = _detection_grid_cell(det, grid_cols, grid_rows)
    for item in recent_detections:
        same_issue = det.issue_type == item["issue_type"] or det.issue_group == item["issue_group"]
        if not same_issue:
            continue
        prev_col, prev_row = item["grid_cell"]
        nearby_cell = abs(col - prev_col) <= 1 and abs(row - prev_row) <= 1
        if nearby_cell and bbox_iou(det.bbox_xyxy, item["bbox_xyxy"]) >= iou_threshold:
            return True
    return False


def _unique_recent_detections(
    detections: list[Detection],
    recent_detections: list[dict[str, Any]],
    frame_index: int,
    config: AppConfig,
) -> tuple[list[Detection], int]:
    if not config.processing.temporal_dedupe:
        return detections, 0

    _prune_recent_detections(
        recent_detections,
        frame_index,
        config.processing.temporal_dedupe_ttl_frames,
    )

    unique: list[Detection] = []
    duplicate_count = 0
    for det in detections:
        if _is_recent_duplicate(
            det,
            recent_detections,
            config.processing.temporal_dedupe_grid_cols,
            config.processing.temporal_dedupe_grid_rows,
            config.processing.temporal_dedupe_iou,
        ):
            duplicate_count += 1
            continue

        unique.append(det)
        recent_detections.append(
            {
                "frame_index": frame_index,
                "issue_group": det.issue_group,
                "issue_type": det.issue_type,
                "bbox_xyxy": det.bbox_xyxy,
                "grid_cell": _detection_grid_cell(
                    det,
                    config.processing.temporal_dedupe_grid_cols,
                    config.processing.temporal_dedupe_grid_rows,
                ),
            }
        )

    return unique, duplicate_count


def process_video(
    source: str | int,
    detector: CivicIssueDetector,
    config: AppConfig,
    output_dir: str | Path = "outputs",
    run_name: str | None = None,
    display: bool = False,
    max_frames: int | None = None,
    save_video_override: bool | None = None,
    snapshot_every_sec: float | None = None,
) -> dict[str, Any]:
    run_dir = _make_run_dir(output_dir, run_name)
    crops_dir = ensure_dir(run_dir / "crops")
    grabs_dir = ensure_dir(run_dir / "screen_grabs")

    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video source: {source}")

    fps = _video_fps(cap)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    if width <= 0 or height <= 0:
        ok, probe_frame = cap.read()
        if not ok:
            cap.release()
            raise RuntimeError("Could not read first frame from source.")
        height, width = probe_frame.shape[:2]
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    save_video = config.processing.save_annotated_video if save_video_override is None else save_video_override
    writer = None
    annotated_video_path = run_dir / "annotated.mp4"
    if save_video:
        writer = _open_video_writer(annotated_video_path, width, height, fps)

    # ROI outline drawn on every annotated frame (empty unless ROI is on + draw).
    roi_px = detector.road_roi_polygon_px(width, height) if config.road_roi.draw else []

    track_mode = config.processing.track_issues
    tracker = IssueTracker(config.processing) if track_mode else None

    # Tracker-mode accumulators (one record per physical issue).
    issue_records: dict[str, dict[str, Any]] = {}
    frame_visibility: list[dict[str, Any]] = []
    raw_detections_total = 0

    # Fallback-mode accumulators (static de-dupe).
    detections_json: list[dict[str, Any]] = []
    frame_events: list[dict[str, Any]] = []
    recent_unique_detections: list[dict[str, Any]] = []
    duplicate_detections_suppressed = 0

    frame_index = -1
    processed_frames = 0
    skipped_similar_frames = 0
    skipped_similar_streak = 0
    previous_inferred_signature: np.ndarray | None = None
    last_inferred_detections: list[Detection] = []
    last_inferred_frame_index: int | None = None
    started_at = datetime.now(timezone.utc)
    last_snapshot_time = time.monotonic()   # for periodic partial detections.json writes

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            frame_index += 1
            if max_frames is not None and frame_index >= max_frames:
                break

            timestamp_sec = _frame_timestamp(cap, frame_index, fps)
            should_infer = frame_index % config.processing.frame_stride == 0
            skipped_for_similarity = False
            current_signature: np.ndarray | None = None
            frame_detections: list[Detection] = []
            annotated = frame

            if should_infer:
                if config.processing.skip_similar_frames and previous_inferred_signature is not None:
                    current_signature = _frame_signature(
                        frame,
                        config.processing.similar_frame_downscale_width,
                    )
                    frame_delta = _mean_frame_delta(previous_inferred_signature, current_signature)
                    can_skip_more = (
                        config.processing.max_similar_frame_skips == 0
                        or skipped_similar_streak < config.processing.max_similar_frame_skips
                    )
                    if (
                        frame_delta is not None
                        and frame_delta <= config.processing.similar_frame_threshold
                        and can_skip_more
                    ):
                        skipped_for_similarity = True
                        skipped_similar_frames += 1
                        skipped_similar_streak += 1
                        frame_detections = last_inferred_detections
                        annotated = draw_detections(frame, frame_detections, config.annotation, roi_px)

                if skipped_for_similarity:
                    if writer is not None:
                        writer.write(annotated)
                    if display:
                        cv2.imshow("Civic Issue Detector", annotated)
                        key = cv2.waitKey(1) & 0xFF
                        if key in (ord("q"), 27):
                            break
                    continue

                frame_detections = detector.predict_frame(frame, frame_index, timestamp_sec)
                if config.processing.cross_model_nms:
                    frame_detections = cross_model_nms(
                        frame_detections,
                        config.processing.cross_model_nms_iou,
                    )
                processed_frames += 1
                raw_detections_total += len(frame_detections)
                skipped_similar_streak = 0
                if current_signature is None:
                    current_signature = _frame_signature(
                        frame,
                        config.processing.similar_frame_downscale_width,
                    )
                previous_inferred_signature = current_signature
                last_inferred_detections = frame_detections
                last_inferred_frame_index = frame_index

                if track_mode and tracker is not None:
                    new_best_ids = tracker.update(frame_detections, frame_index, timestamp_sec)
                    annotated = draw_detections(frame, frame_detections, config.annotation, roi_px)
                    _record_new_best_issues(
                        new_best_ids=new_best_ids,
                        frame=frame,
                        annotated=annotated,
                        frame_detections=frame_detections,
                        issue_records=issue_records,
                        crops_dir=crops_dir,
                        grabs_dir=grabs_dir,
                        run_dir=run_dir,
                        config=config,
                    )
                    if frame_detections:
                        frame_visibility.append(
                            {
                                "frame_index": frame_index,
                                "timestamp_sec": round(float(timestamp_sec), 3),
                                "issue_ids": [
                                    d.issue_id for d in frame_detections if d.issue_id
                                ],
                            }
                        )
                else:
                    unique_frame_detections, duplicate_count = _unique_recent_detections(
                        frame_detections,
                        recent_unique_detections,
                        frame_index,
                        config,
                    )
                    duplicate_detections_suppressed += duplicate_count
                    annotated = draw_detections(frame, frame_detections, config.annotation, roi_px)
                    _emit_static_detections(
                        unique_frame_detections=unique_frame_detections,
                        frame=frame,
                        annotated=annotated,
                        frame_index=frame_index,
                        timestamp_sec=timestamp_sec,
                        crops_dir=crops_dir,
                        grabs_dir=grabs_dir,
                        run_dir=run_dir,
                        config=config,
                        detections_json=detections_json,
                        frame_events=frame_events,
                    )

            elif (
                config.processing.persist_detections_between_inferences
                and last_inferred_detections
                and last_inferred_frame_index is not None
            ):
                frames_since_inference = frame_index - last_inferred_frame_index
                max_persisted_frames = (
                    config.processing.max_persisted_detection_frames
                    or max(0, config.processing.frame_stride - 1)
                )
                if frames_since_inference <= max_persisted_frames:
                    annotated = draw_detections(
                        frame, last_inferred_detections, config.annotation, roi_px
                    )

            if writer is not None:
                writer.write(annotated)

            if display:
                cv2.imshow("Civic Issue Detector", annotated)
                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), 27):
                    break

            # Periodically flush a partial detections.json of confirmed-so-far issues so a
            # dashboard can watch de-duplicated issues accumulate while the video processes.
            if snapshot_every_sec and track_mode and tracker is not None:
                now_monotonic = time.monotonic()
                if now_monotonic - last_snapshot_time >= snapshot_every_sec:
                    _write_partial_snapshot(
                        run_dir=run_dir, tracker=tracker, issue_records=issue_records,
                        source=source, fps=fps, width=width, height=height,
                        last_frame_index=frame_index, started_at=started_at,
                    )
                    last_snapshot_time = now_monotonic
                    print(f"  snapshot: {len(tracker.confirmed_tracks())} confirmed issues", flush=True)

            if processed_frames and processed_frames % 30 == 0 and should_infer:
                live_count = len(issue_records) if track_mode else len(detections_json)
                print(
                    f"Processed {processed_frames} inference frames; "
                    f"{'issues' if track_mode else 'detections'}: {live_count}",
                    flush=True,
                )

    except KeyboardInterrupt:
        # Stopped early (Ctrl-C): fall through and still write the JSON/summary
        # for everything processed so far, so the dashboard always has data.
        print("\nInterrupted - writing detections.json for frames processed so far...", flush=True)
    finally:
        cap.release()
        if writer is not None:
            writer.release()
        if display:
            cv2.destroyAllWindows()

    ended_at = datetime.now(timezone.utc)

    if track_mode and tracker is not None:
        issues, detections_json, frame_events, issue_type_counts = _finalize_tracked_issues(
            tracker=tracker,
            issue_records=issue_records,
            frame_visibility=frame_visibility,
            run_dir=run_dir,
        )
        deduped_count = raw_detections_total - len(issues)
    else:
        issues = []
        issue_type_counts = dict(Counter(d["issue_type"] for d in detections_json))
        deduped_count = duplicate_detections_suppressed

    summary = {
        "source": str(source),
        "run_dir": run_dir.as_posix(),
        "created_at_utc": started_at.isoformat(),
        "completed_at_utc": ended_at.isoformat(),
        "video": {
            "fps": fps,
            "width": width,
            "height": height,
            "reported_total_frames": total_frames,
            "last_frame_index": frame_index,
            "inference_frames_processed": processed_frames,
            "similar_frames_skipped": skipped_similar_frames,
            "raw_detections_total": raw_detections_total,
            "duplicate_detections_suppressed": deduped_count,
        },
        "issue_summary": {
            "unique_issues": len(issues) if track_mode else len(detections_json),
            "by_issue_type": issue_type_counts,
        },
        "outputs": {
            "annotated_video_path": relpath(annotated_video_path, run_dir) if save_video else None,
            "detections_json_path": "detections.json",
            "screen_grabs_dir": "screen_grabs" if config.processing.save_screen_grabs else None,
            "crops_dir": "crops" if config.processing.save_detection_crops else None,
        },
        "models": [
            {
                "name": spec.name,
                "weights": spec.weights,
                "issue_group": spec.issue_group,
                "confidence_threshold": spec.confidence_threshold,
                "iou_threshold": spec.iou_threshold,
                "image_size": spec.image_size,
            }
            for spec, _ in detector.models
        ],
        "suppressor": {
            "enabled": config.suppressor.enabled,
            "weights": config.suppressor.weights,
            "confidence_threshold": config.suppressor.confidence_threshold,
            "containment_threshold": config.suppressor.containment_threshold,
            "suppress_classes": config.suppressor.suppress_classes,
            "apply_to_issue_groups": config.suppressor.apply_to_issue_groups,
        },
        "road_roi": {
            "enabled": config.road_roi.enabled,
            "polygon": config.road_roi.polygon,
            "apply_to_issue_groups": config.road_roi.apply_to_issue_groups,
            "test_point": config.road_roi.test_point,
        },
        "processing": {
            "frame_stride": config.processing.frame_stride,
            "skip_similar_frames": config.processing.skip_similar_frames,
            "similar_frame_threshold": config.processing.similar_frame_threshold,
            "similar_frame_downscale_width": config.processing.similar_frame_downscale_width,
            "max_similar_frame_skips": config.processing.max_similar_frame_skips,
            "persist_detections_between_inferences": (
                config.processing.persist_detections_between_inferences
            ),
            "max_persisted_detection_frames": config.processing.max_persisted_detection_frames,
            "track_issues": config.processing.track_issues,
            "track_iou": config.processing.track_iou,
            "track_center_dist_ratio": config.processing.track_center_dist_ratio,
            "track_motion_gate_growth": config.processing.track_motion_gate_growth,
            "track_max_age_frames": config.processing.track_max_age_frames,
            "track_min_hits": config.processing.track_min_hits,
            "temporal_dedupe": config.processing.temporal_dedupe,
            "temporal_dedupe_iou": config.processing.temporal_dedupe_iou,
            "cross_model_nms": config.processing.cross_model_nms,
            "cross_model_nms_iou": config.processing.cross_model_nms_iou,
        },
        "frames_with_detections": frame_events,
        "issues": issues,
        "detections": detections_json,
    }

    save_json(run_dir / "detections.json", summary)
    save_json(
        run_dir / "summary.json",
        {k: v for k, v in summary.items() if k not in ("detections",)},
    )
    print(
        f"Output written to: {run_dir} "
        f"({summary['issue_summary']['unique_issues']} unique issues)",
        flush=True,
    )
    return summary


def _record_new_best_issues(
    new_best_ids: list[str],
    frame: np.ndarray,
    annotated: np.ndarray,
    frame_detections: list[Detection],
    issue_records: dict[str, dict[str, Any]],
    crops_dir: Path,
    grabs_dir: Path,
    run_dir: Path,
    config: AppConfig,
) -> None:
    """Write / overwrite exactly one crop + screen grab per issue whenever the
    issue's best (highest-confidence) frame improves."""
    if not new_best_ids:
        return
    by_id = {d.issue_id: d for d in frame_detections if d.issue_id}
    for issue_id in new_best_ids:
        det = by_id.get(issue_id)
        if det is None:
            continue
        record = issue_records.setdefault(issue_id, {})
        if config.processing.save_detection_crops:
            crop_path = save_issue_crop(
                frame=frame,
                det=det,
                crop_dir=crops_dir,
                output_root=run_dir,
                padding_ratio=config.processing.crop_padding_ratio,
            )
            # If the issue_type (hence filename) changed, drop the stale crop so
            # each issue keeps exactly one crop file.
            previous = record.get("crop_path")
            if previous and previous != crop_path:
                remove_output_file(previous, run_dir)
            record["crop_path"] = crop_path
            det.crop_path = crop_path
        if config.processing.save_screen_grabs:
            grab_path = grabs_dir / f"{issue_id}.jpg"
            cv2.imwrite(str(grab_path), annotated)
            grab_rel = relpath(grab_path, run_dir)
            record["screen_grab_path"] = grab_rel
            det.screen_grab_path = grab_rel
        record["detection"] = det.to_dict()


def _emit_static_detections(
    unique_frame_detections: list[Detection],
    frame: np.ndarray,
    annotated: np.ndarray,
    frame_index: int,
    timestamp_sec: float,
    crops_dir: Path,
    grabs_dir: Path,
    run_dir: Path,
    config: AppConfig,
    detections_json: list[dict[str, Any]],
    frame_events: list[dict[str, Any]],
) -> None:
    if not unique_frame_detections:
        return
    if config.processing.save_detection_crops:
        for det in unique_frame_detections:
            det.crop_path = save_detection_crop(
                frame=frame,
                det=det,
                crop_dir=crops_dir,
                output_root=run_dir,
                padding_ratio=config.processing.crop_padding_ratio,
            )
    if config.processing.save_screen_grabs:
        grab_path = grabs_dir / _screen_grab_filename(frame_index, timestamp_sec)
        cv2.imwrite(str(grab_path), annotated)
        grab_rel = relpath(grab_path, run_dir)
        for det in unique_frame_detections:
            det.screen_grab_path = grab_rel
    detections_json.extend(det.to_dict() for det in unique_frame_detections)
    frame_events.append(
        {
            "frame_index": frame_index,
            "timestamp_sec": round(float(timestamp_sec), 3),
            "screen_grab_path": unique_frame_detections[0].screen_grab_path,
            "detection_ids": [det.detection_id for det in unique_frame_detections],
            "issue_types": sorted({det.issue_type for det in unique_frame_detections}),
        }
    )


def _finalize_tracked_issues(
    tracker: IssueTracker,
    issue_records: dict[str, dict[str, Any]],
    frame_visibility: list[dict[str, Any]],
    run_dir: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    confirmed = tracker.confirmed_tracks()
    confirmed_ids = {t.issue_id for t in confirmed}

    # Delete crops / grabs written for tracks that never reached track_min_hits.
    for issue_id, record in issue_records.items():
        if issue_id not in confirmed_ids:
            remove_output_file(record.get("crop_path"), run_dir)
            remove_output_file(record.get("screen_grab_path"), run_dir)

    issues: list[dict[str, Any]] = []
    detections_json: list[dict[str, Any]] = []
    for track in confirmed:
        record = issue_records.get(track.issue_id, {})
        best = record.get("detection")
        issues.append(
            {
                "issue_id": track.issue_id,
                "issue_type": track.issue_type,
                "issue_group": track.issue_group,
                "model_name": track.model_name,
                "peak_confidence_pct": round(track.best_confidence * 100.0, 2),
                "detection_count": track.hit_count,
                "first_frame_index": track.first_frame,
                "last_frame_index": track.last_frame,
                "first_timestamp_sec": round(track.first_ts, 3),
                "last_timestamp_sec": round(track.last_ts, 3),
                "bbox_xyxy": best.get("bbox_xyxy") if best else None,
                "crop_path": record.get("crop_path"),
                "screen_grab_path": record.get("screen_grab_path"),
            }
        )
        if best:
            detections_json.append(best)

    frame_events: list[dict[str, Any]] = []
    for visibility in frame_visibility:
        visible_ids = [
            issue_id
            for issue_id in dict.fromkeys(visibility["issue_ids"])
            if issue_id in confirmed_ids
        ]
        if not visible_ids:
            continue
        frame_events.append(
            {
                "frame_index": visibility["frame_index"],
                "timestamp_sec": visibility["timestamp_sec"],
                "issue_ids": visible_ids,
                "issue_types": sorted(
                    {tracker.tracks[i].issue_type for i in visible_ids}
                ),
            }
        )

    issue_type_counts = dict(Counter(t.issue_type for t in confirmed))
    return issues, detections_json, frame_events, issue_type_counts


def _write_partial_snapshot(
    run_dir: Path,
    tracker: IssueTracker,
    issue_records: dict[str, dict[str, Any]],
    source: str | int,
    fps: float,
    width: int,
    height: int,
    last_frame_index: int,
    started_at: datetime,
) -> None:
    """Write a partial detections.json of confirmed-so-far issues DURING processing.

    Same shape as the final file but non-destructive: it never prunes crops/grabs
    (an unconfirmed track may still be confirmed later). The final write at the end
    overwrites this with the complete, pruned summary.
    """
    confirmed = tracker.confirmed_tracks()
    issues: list[dict[str, Any]] = []
    detections: list[dict[str, Any]] = []
    for track in confirmed:
        record = issue_records.get(track.issue_id, {})
        best = record.get("detection")
        issues.append(
            {
                "issue_id": track.issue_id,
                "issue_type": track.issue_type,
                "issue_group": track.issue_group,
                "model_name": track.model_name,
                "peak_confidence_pct": round(track.best_confidence * 100.0, 2),
                "detection_count": track.hit_count,
                "first_frame_index": track.first_frame,
                "last_frame_index": track.last_frame,
                "first_timestamp_sec": round(track.first_ts, 3),
                "last_timestamp_sec": round(track.last_ts, 3),
                "bbox_xyxy": best.get("bbox_xyxy") if best else None,
                "crop_path": record.get("crop_path"),
                "screen_grab_path": record.get("screen_grab_path"),
            }
        )
        if best:
            detections.append(best)
    summary = {
        "source": str(source),
        "run_dir": run_dir.as_posix(),
        "created_at_utc": started_at.isoformat(),
        "completed_at_utc": datetime.now(timezone.utc).isoformat(),
        "partial": True,
        "video": {
            "fps": fps,
            "width": width,
            "height": height,
            "last_frame_index": last_frame_index,
        },
        "issue_summary": {
            "unique_issues": len(issues),
            "by_issue_type": dict(Counter(t.issue_type for t in confirmed)),
        },
        "issues": issues,
        "detections": detections,
    }
    save_json(run_dir / "detections.json", summary)
