# assets

Drop your demo dashcam clip here as **`demo.mp4`**.

- The Fleet & replay view (`index.html` → Fleet) loads `assets/demo.mp4` in the
  dashcam slot and syncs the map replay + detection feed to its playback.
- `pipeline/run_demo.sh` runs the detector on this same file by default.

Nothing else is required — if `demo.mp4` is absent, the replay falls back to the
built-in timeline animation and the dashboard still works.
