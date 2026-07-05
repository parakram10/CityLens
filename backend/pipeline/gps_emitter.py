"""GPS emitter for the CityLens demo.

The dashcam clip has no GPS. This module fakes the GPS device that would normally
run alongside the camera: given a route (a list of lat/lon waypoints) and a video
duration, it maps any video timestamp to a coordinate on the route.

    emitter = GpsEmitter.from_file("gps_track.json", duration_override=video_len)
    lat, lon, heading = emitter.locate(timestamp_sec)

`stream()` dumps a full per-frame track (like a real logger) so the same shape can
later be replaced by a genuine GPX/CSV recording with no code changes elsewhere.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator


EARTH_RADIUS_M = 6371000.0


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in metres between two (lat, lon) points."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Compass bearing in degrees (0..360) from point a to point b."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlon = math.radians(b[1] - a[1])
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def offset_m(lat: float, lon: float, north_m: float, east_m: float) -> tuple[float, float]:
    """Shift a coordinate by a north/east offset in metres (used for GPS jitter)."""
    dlat = north_m / EARTH_RADIUS_M
    dlon = east_m / (EARTH_RADIUS_M * math.cos(math.radians(lat)))
    return lat + math.degrees(dlat), lon + math.degrees(dlon)


@dataclass
class GpsFix:
    t_sec: float
    lat: float
    lon: float
    heading: float


class GpsEmitter:
    def __init__(
        self,
        waypoints: list[tuple[float, float]],
        duration_sec: float,
        route: str = "route",
        default_bus: str | None = None,
        motion: list[tuple[float, float]] | None = None,
        max_length_m: float | None = None,
    ) -> None:
        if len(waypoints) < 2:
            raise ValueError("A route needs at least two waypoints.")
        self.waypoints = waypoints
        self.duration_sec = float(duration_sec) if duration_sec and duration_sec > 0 else 1.0
        self.route = route
        self.default_bus = default_bus
        # Cap how much of the route the clip traverses. Without this, a short clip is
        # stretched across the whole (long) corridor, implying an absurd speed and
        # spreading same-spot re-detections tens of metres apart (defeating de-dup).
        self.max_length_m = max_length_m
        # Optional motion profile from estimate_motion.py: [(t_sec, cum_frac 0..1)].
        # When present, time -> distance follows the *video's* real pacing; otherwise
        # we fall back to constant speed (time fraction == distance fraction).
        self._motion_t: list[float] = []
        self._motion_cum: list[float] = []
        if motion:
            motion = sorted(motion, key=lambda p: p[0])
            self._motion_t = [float(t) for t, _ in motion]
            self._motion_cum = [float(c) for _, c in motion]
        # Cumulative arc length so a distance fraction maps to a point on the route.
        self._cum: list[float] = [0.0]
        for a, b in zip(waypoints, waypoints[1:]):
            self._cum.append(self._cum[-1] + haversine_m(a, b))
        self.length_m = self._cum[-1]
        # Effective distance the clip actually covers along the route.
        self.traverse_m = (
            min(self.length_m, max_length_m)
            if max_length_m and max_length_m > 0
            else self.length_m
        )

    @classmethod
    def from_file(
        cls,
        path: str | Path,
        duration_override: float | None = None,
        motion_path: str | Path | None = None,
        max_length_m: float | None = None,
    ) -> "GpsEmitter":
        track = json.loads(Path(path).read_text())
        wps = [(float(w["lat"]), float(w["lon"])) for w in track["waypoints"]]
        motion = None
        duration = duration_override or float(track.get("duration_sec", 240.0))
        if motion_path:
            prof = json.loads(Path(motion_path).read_text())
            motion = [(s["t"], s["cum"]) for s in prof.get("samples", [])]
            duration = duration_override or float(prof.get("duration_sec", duration))
            # Distance the vehicle actually traveled (integral of the estimated speed) is
            # how far along the route we move — trim the rest of the corridor.
            if prof.get("distance_m"):
                max_length_m = float(prof["distance_m"])
        return cls(
            wps, duration, track.get("route", "route"), track.get("default_bus"),
            motion, max_length_m,
        )

    def distance_frac(self, t_sec: float) -> float:
        """Fraction (0..1) of the route travelled by video time t_sec."""
        if self._motion_t:
            if t_sec <= self._motion_t[0]:
                return self._motion_cum[0]
            if t_sec >= self._motion_t[-1]:
                return self._motion_cum[-1]
            # Linear interpolation within the motion curve.
            lo, hi = 0, len(self._motion_t) - 1
            while lo < hi:
                mid = (lo + hi) // 2
                if self._motion_t[mid] < t_sec:
                    lo = mid + 1
                else:
                    hi = mid
            i = max(1, lo)
            t0, t1 = self._motion_t[i - 1], self._motion_t[i]
            c0, c1 = self._motion_cum[i - 1], self._motion_cum[i]
            f = 0.0 if t1 <= t0 else (t_sec - t0) / (t1 - t0)
            return c0 + (c1 - c0) * f
        return min(1.0, max(0.0, t_sec / self.duration_sec))

    def locate(self, t_sec: float) -> tuple[float, float, float]:
        """Return (lat, lon, heading) for a video timestamp, clamped to the route ends."""
        if self.length_m <= 0:
            lat, lon = self.waypoints[0]
            return lat, lon, 0.0
        target = self.distance_frac(t_sec) * self.traverse_m
        for i in range(len(self._cum) - 1):
            seg_end = self._cum[i + 1]
            if target <= seg_end or i == len(self._cum) - 2:
                seg_len = seg_end - self._cum[i]
                f = 0.0 if seg_len <= 0 else (target - self._cum[i]) / seg_len
                a, b = self.waypoints[i], self.waypoints[i + 1]
                lat = a[0] + (b[0] - a[0]) * f
                lon = a[1] + (b[1] - a[1]) * f
                return lat, lon, bearing_deg(a, b)
        lat, lon = self.waypoints[-1]
        return lat, lon, 0.0

    def stream(self, hz: float = 1.0) -> Iterator[GpsFix]:
        """Yield a GpsFix at `hz` Hz across the whole clip — a full mock GPS log."""
        step = 1.0 / hz
        t = 0.0
        while t <= self.duration_sec + 1e-9:
            lat, lon, heading = self.locate(t)
            yield GpsFix(round(t, 3), lat, lon, round(heading, 1))
            t += step


def write_gpx(emitter: GpsEmitter, path: str | Path, hz: float = 1.0) -> None:
    """Dump the mock track as a GPX file (handy to show 'the GPS feed' in a demo)."""
    pts = [
        f'    <trkpt lat="{fix.lat:.6f}" lon="{fix.lon:.6f}"><time>t{fix.t_sec}</time></trkpt>'
        for fix in emitter.stream(hz)
    ]
    doc = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" creator="CityLens gps_emitter">\n'
        f"  <trk><name>{emitter.route}</name><trkseg>\n"
        + "\n".join(pts)
        + "\n  </trkseg></trk>\n</gpx>\n"
    )
    Path(path).write_text(doc)


if __name__ == "__main__":
    # Quick self-check / GPX dump: python gps_emitter.py [gps_track.json] [out.gpx]
    import sys

    track_path = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).with_name("gps_track.json"))
    em = GpsEmitter.from_file(track_path)
    print(f"route={em.route} length={em.length_m:.0f} m duration={em.duration_sec:.0f} s")
    for t in (0.0, em.duration_sec / 2, em.duration_sec):
        lat, lon, hd = em.locate(t)
        print(f"  t={t:7.1f}s -> {lat:.5f}, {lon:.5f}  heading {hd:.0f}")
    if len(sys.argv) > 2:
        write_gpx(em, sys.argv[2])
        print(f"wrote {sys.argv[2]}")
