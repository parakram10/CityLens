# CityLens backend

Everything that turns a dashcam clip into the pins you see on the dashboard lives
here. The frontend (`../index.html`, `../js`, `../css`) is a static site; this
backend runs locally to *generate* the data it loads.

```
backend/
├── setup.sh              One-time: create venv, install deps, print next steps
├── detector/            The YOLO civic-issue detector (pothole / garbage)
│   ├── civic_issue_detector/   Python package (run: python -m civic_issue_detector)
│   ├── scripts/                Helpers (download_models.py, extract_frames.py, …)
│   ├── models/                 Weights (.pt) — kept OUT of git
│   ├── config.yaml             Model + class config
│   └── requirements.txt        Detector + pipeline deps (cv2, numpy, ultralytics)
└── pipeline/           The bridge: detector output -> dashboard data
    ├── estimate_motion.py      Optical-flow camera-motion / speed estimator
    ├── gps_emitter.py          Maps video time -> lat/lon along the A-71 route
    ├── build_dashboard_data.py Geolocate + enrich + de-dup -> js/live.js + js/live.json
    ├── gps_track.json          Route waypoints
    ├── motion_vid-*.json       Precomputed motion profiles (committed)
    ├── run_demo.sh             One-shot: detect -> motion -> build
    └── run_live.sh             Live: build repeatedly as the detector streams snapshots
```

## Data flow

```
clip.mp4 ─┬─► detector (YOLO) ───► outputs/<run>/detections.json  (timestamps, crops, grabs)
          └─► estimate_motion ──► motion_<clip>.json              (speed shape, distance_m)
                                        │
             detections + motion ──► build_dashboard_data.py
                                        │  geolocate @ last-seen · ward via point-in-polygon
                                        │  severity · simulate passes · spatial de-dup
                                        ▼
                          ../js/live.js   (committed — deployed site loads it)
                          ../js/live.json (committed — dashboard polls it live, no reload)
                          ../assets/evidence/<id>.jpg  (real detection frames)
```

## Quick start

```bash
bash backend/setup.sh                 # venv + deps (one time)
# put a clip at assets/demo.mp4, then:
backend/pipeline/run_demo.sh          # regenerate js/live.js from the clip
python3 -m http.server 5173 --directory .   # open http://localhost:5173/
```

## What's committed vs. not

Committed: all code, the motion profiles, `assets/evidence/*.jpg`, and the
generated `js/live.js` / `js/live.json` (the deployed GitHub Pages site has no
build step, so these ship as artifacts).

Not committed (see `../.gitignore`): the venv, model weights (`*.pt`), detector
run `outputs/`, the training `dataset/`, and source videos (`assets/*.mp4` — too
large for git; `vid-2.mp4` exceeds GitHub's 100 MB cap).
