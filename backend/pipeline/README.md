# CityLens pipeline — backend ↔ dashboard bridge

Turns the [`civic_issue_video_detector`](../../civic_issue_video_detector) output
into dashboard data. The detector locates issues only by video timestamp; this
pipeline gives each one a GPS coordinate, reshapes it into the dashboard's issue
model, de-duplicates repeat sightings, and writes `../js/live.js`.

```
demo.mp4 ──► detector ──► detections.json
                                │
        gps_track.json ──► build_dashboard_data.py ──► ../js/live.js
                                │  geolocate · enrich · de-dup
   index.html loads  data.js → live.js → app.js
```

## Run it

```bash
# Full run: detector on a clip, then build live.js
pipeline/run_demo.sh assets/demo.mp4

# No clip yet? Regenerate from the bundled sample:
python3 pipeline/build_dashboard_data.py
```

Then open `index.html` (double-click — no server required).

## Pieces

| File | What it does |
|------|--------------|
| `gps_emitter.py` | The **GPS mock**. Maps a video timestamp to a lat/lon on the route. `python gps_emitter.py gps_track.json out.gpx` dumps the whole track as GPX. Swap in a real GPX/CSV by editing `gps_track.json`. |
| `gps_track.json` | Route waypoints (`[lat, lon]`) + timing. Seeded from the A-71 / Western Express Hwy corridor already drawn in the Fleet replay. |
| `build_dashboard_data.py` | The bridge. Geolocates, enriches (ward via point-in-polygon, severity from confidence + box size, type map), **simulates multiple bus passes**, **spatially de-dups** (same type within `MERGE_RADIUS_M` = one pin), and emits `live.js`. |
| `sample_detections.json` | A stand-in detector output so the dashboard works before a real run. |
| `run_demo.sh` | One-command orchestration. |

## De-dup & passes (the two asks)

- **GPS emitter** — `gps_emitter.py` is the standalone GPS device stand-in.
- **Never plot a location twice** — each detection is expanded into several
  jittered pass-sightings, then `merge_sightings()` collapses same-type sightings
  within `MERGE_RADIUS_M` (default 20 m) into a single pin. `passes` = how many
  sightings merged; `passes ≥ 3` flips an issue to **confirmed**.

Tuning knobs live at the top of `build_dashboard_data.py`
(`MERGE_RADIUS_M`, `PASSES_MIN/MAX`, `KEEP_SEED_PER_TRIM_TYPE`, …).

## What `live.js` does

Generated, safe to delete/regenerate. Between `data.js` and `app.js` it:
1. trims the seed **pothole** + **garbage** pins down to a few mocked ones
   (waterlogging + obstruction seed kept intact — the models don't detect those);
2. pushes the real detections into `DATA.issues`;
3. repoints `DATA.replay_ids` at the real detections, in route order.
