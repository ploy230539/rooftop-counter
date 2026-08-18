# Open Buildings tile pipeline

Builds the static building-count data used by the map mode's **"นับจาก Open Buildings"** button.

## What it does

1. Queries **Google-Microsoft Open Buildings** (VIDA GeoParquet) for a bounding box — real
   AI-detected building footprints, far more complete than OSM in Thai suburbs
   (Bang Phli 1 km²: OSM = 77, Open Buildings = 1,465).
2. Keeps only "real houses" (confidence ≥ 0.70, area ≥ 15 m²).
3. Splits the building centroids into a **0.01° tile grid** and writes
   `../../buildings/{tx}_{ty}.json` (each ~30–90 KB).

The web app fetches only the tiles overlapping the area you draw (~300 KB per count),
so it stays fast no matter how large the full dataset is — the same trick map tiles use.

## Run it

```bash
pip install duckdb
python build_tiles.py
```

## Scale to more area

Edit `BBOX` at the top of `build_tiles.py`, then re-run. It overwrites the tiles it
touches and leaves other regions intact, so you can add areas incrementally.

- Bang Phli / Bang Na pilot (default): `W,S,E,N = 100.63, 13.60, 100.73, 13.69`
- Bangkok metro (≈5.5M buildings, big/slow, many tiles): `100.25, 13.45, 100.95, 14.15`

`TILE` must stay `0.01` — it has to match `OB_TILE` in `map-mode.js`.

## Data source & license

Google-Microsoft-OSM Open Buildings, combined by VIDA, on Source Cooperative:
`s3://us-west-2.opendata.source.coop/vida/google-microsoft-open-buildings/...`
Underlying data: Google Open Buildings (CC BY-4.0) + Microsoft (ODbL) + OSM (ODbL).
