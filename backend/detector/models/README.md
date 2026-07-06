# Model weights

This folder is intentionally empty in the project zip.

Download the default public YOLO weights with:

```bash
python scripts/download_models.py --all
```

Expected files after download:

- `models/litter_yolov8m_aryanshh_best.pt`
- `models/rdd2022_yolo12m_seed0_best.pt`
- `models/rdd2022_yolo12s_800px_seed0_best.pt`

You can also place your own YOLO `.pt` files here and update `config.yaml`.
