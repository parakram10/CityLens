#!/usr/bin/env bash
# One-time setup for the CityLens backend (detector + pipeline).
# Creates the detector's Python venv, installs deps, and lists the remaining
# manual steps (model weights + source videos, both kept out of git).
#
#   bash backend/setup.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"          # backend
DETECTOR="$HERE/detector"
CITYLENS="$(cd "$HERE/.." && pwd)"             # repo root

echo "==> Creating venv at $DETECTOR/.venv"
python3 -m venv "$DETECTOR/.venv"
"$DETECTOR/.venv/bin/pip" install --upgrade pip
"$DETECTOR/.venv/bin/pip" install -r "$DETECTOR/requirements.txt"

# macOS Gatekeeper can quarantine freshly installed native libs (cv2/numpy),
# breaking imports with "library load disallowed by system policy". Clear it.
if [ "$(uname)" = "Darwin" ]; then
  echo "==> Clearing macOS quarantine on the venv"
  xattr -dr com.apple.quarantine "$DETECTOR/.venv" 2>/dev/null || true
fi

echo "==> Verifying imports"
"$DETECTOR/.venv/bin/python" -c \
  "import cv2, numpy, ultralytics; print('cv2', cv2.__version__, '| numpy', numpy.__version__)"

cat <<EOF

Setup done. Remaining manual steps:

  1. Model weights: custom fine-tuned weights already sit in
     backend/detector/models/ (kept out of git). To (re)download the public
     YOLO road-damage weights:
       cd backend/detector && .venv/bin/python scripts/download_models.py --all

  2. Source videos are NOT committed (too large for git). Drop your clip(s)
     into $CITYLENS/assets/ and point the demo symlink at one:
       ln -sf vid-1.mp4 $CITYLENS/assets/demo.mp4

  3. Run the pipeline (detector -> motion -> dashboard data):
       backend/pipeline/run_demo.sh            # one-shot
       backend/pipeline/run_live.sh            # live, updates as it processes

  4. Serve the dashboard:
       python3 -m http.server 5173 --directory $CITYLENS
EOF
