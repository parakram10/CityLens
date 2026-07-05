#!/usr/bin/env bash
# CityLens LIVE pipeline: watch detections populate the dashboard as the video processes.
#   1. estimate camera motion once (full clip is on disk)
#   2. run the detector with periodic partial-JSON snapshots (de-dup settles over passes)
#   3. every few seconds, rebuild js/live.js + js/live.json from the latest snapshot
#   4. the dashboard polls js/live.json and updates the map/lists in place (no reload)
#
# Usage:  backend/pipeline/run_live.sh [path/to/clip.mp4]
# Env:    SNAPSHOT_SEC (detector snapshot cadence, default 30)
#         REBUILD_SEC  (dashboard rebuild cadence, default 12)
#         DETECTOR_DIR (default: backend/detector)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"          # backend/pipeline
BACKEND="$(cd "$HERE/.." && pwd)"              # backend
CITYLENS="$(cd "$HERE/../.." && pwd)"          # repo root
DETECTOR="${DETECTOR_DIR:-$BACKEND/detector}"
CLIP="${1:-$CITYLENS/assets/demo.mp4}"
CLIP="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$CLIP")"
# Distinct run id per clip -> each clip is its own Fleet trip; snapshots update it in place.
RUN_NAME="$(basename "${CLIP%.*}")"
SNAPSHOT_SEC="${SNAPSHOT_SEC:-30}"
REBUILD_SEC="${REBUILD_SEC:-12}"
DET="$DETECTOR/outputs/$RUN_NAME/detections.json"

PY="python3"
[ -x "$DETECTOR/.venv/bin/python" ] && PY="$DETECTOR/.venv/bin/python"

if [ ! -f "$CLIP" ]; then echo "No clip at $CLIP"; exit 1; fi

build(){ python3 "$HERE/build_dashboard_data.py" \
  --detections "$DET" --data "$CITYLENS/js/data.js" --out "$CITYLENS/js/live.js" "${MOTION_ARG[@]}"; }

# 1. Motion pacing (once, from the full clip).
MOTION_ARG=()
if "$PY" -c "import cv2" >/dev/null 2>&1; then
  MJSON="$HERE/motion_$(basename "${CLIP%.*}").json"
  echo "==> Estimating motion from $CLIP"
  "$PY" "$HERE/estimate_motion.py" --video "$CLIP" --out "$MJSON" && MOTION_ARG=(--motion "$MJSON") || true
fi

# 2. Detector with periodic snapshots, in the background.
echo "==> Detecting on $CLIP (snapshot every ${SNAPSHOT_SEC}s, rebuild every ${REBUILD_SEC}s)"
( cd "$DETECTOR" && "$PY" -m civic_issue_detector \
    --source "$CLIP" --run-name "$RUN_NAME" --snapshot-every-sec "$SNAPSHOT_SEC" ) &
DETPID=$!
trap 'kill "$DETPID" 2>/dev/null || true' EXIT

# 3. Rebuild loop while the detector runs.
echo "==> Watching. Open $CITYLENS/index.html — detections appear as they're found."
while kill -0 "$DETPID" 2>/dev/null; do
  [ -f "$DET" ] && build >/dev/null 2>&1 || true
  sleep "$REBUILD_SEC"
done

# 4. Final rebuild from the complete detections.json.
wait "$DETPID" 2>/dev/null || true
if [ -f "$DET" ]; then echo "==> Detector finished — final rebuild:"; build; fi
echo "==> Done."
