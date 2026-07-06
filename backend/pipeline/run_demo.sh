#!/usr/bin/env bash
# CityLens end-to-end demo pipeline:
#   1. run the civic-issue detector on a clip           -> detections.json
#   2. estimate camera motion from the clip (optical flow) -> motion_<clip>.json
#   3. bridge detections + motion -> js/live.js (geolocate + de-dup, video-paced)
#   4. open index.html (no server needed)
#
# Usage:  backend/pipeline/run_demo.sh [path/to/clip.mp4]
# Env:    DETECTOR_DIR=/path/to/detector  (default: backend/detector)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"          # backend/pipeline
BACKEND="$(cd "$HERE/.." && pwd)"              # backend
CITYLENS="$(cd "$HERE/../.." && pwd)"          # repo root
DETECTOR="${DETECTOR_DIR:-$BACKEND/detector}"
CLIP="${1:-$CITYLENS/assets/demo.mp4}"
# Resolve to an absolute path: the detector runs from $DETECTOR (a different cwd), so a
# relative clip path would break there even though it exists here.
CLIP="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$CLIP")"
# Distinct run id per clip -> each clip is its own Fleet trip; re-running a clip updates it.
RUN_NAME="$(basename "${CLIP%.*}")"
DET="$HERE/sample_detections.json"   # fallback if the detector can't run

# Prefer the detector's venv python (has cv2/numpy for optical flow + YOLO).
PY="python3"
[ -x "$DETECTOR/.venv/bin/python" ] && PY="$DETECTOR/.venv/bin/python"

if [ -f "$CLIP" ] && [ -d "$DETECTOR" ]; then
  echo "==> Running detector on $CLIP"
  if ( cd "$DETECTOR" && "$PY" -m civic_issue_detector --source "$CLIP" --run-name "$RUN_NAME" ); then
    CANDIDATE="$DETECTOR/outputs/$RUN_NAME/detections.json"
    [ -f "$CANDIDATE" ] && DET="$CANDIDATE"
  else
    echo "!! Detector run failed — falling back to bundled sample detections."
  fi
else
  echo "==> No clip at $CLIP (or detector dir missing) — using bundled sample detections."
fi

# Estimate motion pacing from the clip (optical flow). Needs cv2 — skip if unavailable.
MOTION_ARG=()
if [ -f "$CLIP" ] && "$PY" -c "import cv2" >/dev/null 2>&1; then
  MOTION_JSON="$HERE/motion_$(basename "${CLIP%.*}").json"
  echo "==> Estimating camera motion from $CLIP"
  if "$PY" "$HERE/estimate_motion.py" --video "$CLIP" --out "$MOTION_JSON"; then
    MOTION_ARG=(--motion "$MOTION_JSON")
  else
    echo "!! Motion estimation failed — falling back to constant-speed pacing."
  fi
else
  echo "==> No clip or no cv2 — using constant-speed pacing."
fi

echo "==> Building js/live.js from $DET"
# Use the detector venv python: build_dashboard_data now reads the source clip (cv2) to draw
# each issue's own box on its evidence frame; falls back gracefully if cv2 is missing.
"$PY" "$HERE/build_dashboard_data.py" \
  --detections "$DET" --data "$CITYLENS/js/data.js" --out "$CITYLENS/js/live.js" "${MOTION_ARG[@]}"

echo "==> Done. Open: $CITYLENS/index.html"
