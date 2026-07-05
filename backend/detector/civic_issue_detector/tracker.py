"""Motion-tolerant issue tracking.

The per-frame detector has no notion of object identity, so a single physical
issue (a pothole, a litter pile) is re-detected on every inference frame. On a
moving camera the box also drifts across the frame, which defeats simple
IoU-against-memory de-duplication.

`IssueTracker` associates detections across frames into tracks using a
motion-aware gate (IoU *or* a normalized-centroid distance that grows with the
gap since the track was last seen). Each track is one physical issue and is
assigned a stable ``issue_id``. Callers use the returned "new best" ids to write
exactly one crop / screen grab per issue (its highest-confidence frame), and read
``tracks`` at the end to emit one summary record per confirmed issue.
"""

from __future__ import annotations

from dataclasses import dataclass

from .detector import bbox_iou
from .schema import Detection, ProcessingConfig


@dataclass
class Track:
    issue_id: str
    issue_type: str
    issue_group: str
    model_name: str
    first_frame: int
    last_frame: int
    first_ts: float
    last_ts: float
    hit_count: int
    best_confidence: float
    best_detection: Detection
    last_bbox: list[int]
    last_center: tuple[float, float]

    @property
    def confirmed_by(self) -> int:
        return self.hit_count


def _norm_center(det: Detection) -> tuple[float, float]:
    x1, y1, x2, y2 = det.bbox_normalized_xyxy
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


class IssueTracker:
    def __init__(self, config: ProcessingConfig) -> None:
        self.config = config
        # Every track ever created (kept for the final per-issue summary).
        self.tracks: dict[str, Track] = {}
        # Ids still eligible for matching; expired tracks leave this set only.
        self._active: set[str] = set()
        self._next_index = 1

    def _new_issue_id(self) -> str:
        issue_id = f"issue_{self._next_index:06d}"
        self._next_index += 1
        return issue_id

    def _expire(self, frame_index: int) -> None:
        max_age = self.config.track_max_age_frames
        if max_age <= 0:
            return
        stale = [
            issue_id
            for issue_id in self._active
            if frame_index - self.tracks[issue_id].last_frame > max_age
        ]
        for issue_id in stale:
            self._active.discard(issue_id)

    def _match(
        self,
        det: Detection,
        frame_index: int,
        used: set[str],
    ) -> str | None:
        center = _norm_center(det)
        best_id: str | None = None
        best_score = -1.0
        for issue_id in self._active:
            if issue_id in used:
                continue
            track = self.tracks[issue_id]
            same_issue = (
                det.issue_type == track.issue_type or det.issue_group == track.issue_group
            )
            if not same_issue:
                continue

            iou = bbox_iou(det.bbox_xyxy, track.last_bbox)
            gap = max(0, frame_index - track.last_frame)
            dist_gate = self.config.track_center_dist_ratio + (
                self.config.track_motion_gate_growth * gap
            )
            dx = center[0] - track.last_center[0]
            dy = center[1] - track.last_center[1]
            dist = (dx * dx + dy * dy) ** 0.5

            matches = iou >= self.config.track_iou or dist <= dist_gate
            if not matches:
                continue

            # Prefer the highest-IoU track; fall back to closest centroid.
            score = iou if iou > 0 else (1.0 - min(1.0, dist))
            if score > best_score:
                best_score = score
                best_id = issue_id
        return best_id

    def update(
        self,
        detections: list[Detection],
        frame_index: int,
        timestamp_sec: float,
    ) -> list[str]:
        """Assign ``issue_id`` to each detection and update tracks.

        Returns the issue ids whose highest-confidence representative changed on
        this frame, so the caller can (re)write that issue's crop / screen grab
        from the current frame.
        """
        self._expire(frame_index)

        new_best_ids: list[str] = []
        used: set[str] = set()

        # Highest-confidence detections claim their track first.
        for det in sorted(detections, key=lambda d: d.confidence, reverse=True):
            center = _norm_center(det)
            match_id = self._match(det, frame_index, used)
            if match_id is None:
                issue_id = self._new_issue_id()
                det.issue_id = issue_id
                self.tracks[issue_id] = Track(
                    issue_id=issue_id,
                    issue_type=det.issue_type,
                    issue_group=det.issue_group,
                    model_name=det.model_name,
                    first_frame=frame_index,
                    last_frame=frame_index,
                    first_ts=float(timestamp_sec),
                    last_ts=float(timestamp_sec),
                    hit_count=1,
                    best_confidence=det.confidence,
                    best_detection=det,
                    last_bbox=list(det.bbox_xyxy),
                    last_center=center,
                )
                self._active.add(issue_id)
                used.add(issue_id)
                new_best_ids.append(issue_id)
                continue

            track = self.tracks[match_id]
            det.issue_id = match_id
            track.hit_count += 1
            track.last_frame = frame_index
            track.last_ts = float(timestamp_sec)
            track.last_bbox = list(det.bbox_xyxy)
            track.last_center = center
            used.add(match_id)
            if det.confidence > track.best_confidence:
                track.best_confidence = det.confidence
                track.best_detection = det
                track.model_name = det.model_name
                new_best_ids.append(match_id)

        return new_best_ids

    def confirmed_tracks(self) -> list[Track]:
        min_hits = self.config.track_min_hits
        tracks = [t for t in self.tracks.values() if t.hit_count >= min_hits]
        return sorted(tracks, key=lambda t: (t.first_frame, t.issue_id))

    def is_confirmed(self, issue_id: str) -> bool:
        track = self.tracks.get(issue_id)
        return bool(track and track.hit_count >= self.config.track_min_hits)
