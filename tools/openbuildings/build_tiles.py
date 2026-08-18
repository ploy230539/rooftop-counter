#!/usr/bin/env python3
"""
Build static building tiles from Google-Microsoft Open Buildings (VIDA dataset).

Pipeline: query the remote GeoParquet for a bounding box -> filter to "real houses"
-> split building centroids into a 0.01-degree tile grid -> write /buildings/{tx}_{ty}.json

The app fetches only the tiles overlapping the area you draw, so counting stays fast
no matter how big the full dataset is.

USAGE
    pip install duckdb
    python build_tiles.py            # builds the default Bang Phli pilot area
    # edit BBOX below to cover a bigger area (e.g. all of Bangkok metro) and re-run

Learned notes (why the code looks like this):
  - SET s3_url_style='path'   -> bucket name has dots; virtual-host URL breaks SSL cert
  - the `bbox` column lets us filter by area WITHOUT decoding WKB geometry (and it
    prunes row groups, so DuckDB only downloads the parts we need)
  - centroid = midpoint of bbox = ((xmin+xmax)/2, (ymin+ymax)/2)
"""
import duckdb, json, os, math, shutil, time

# ---- CONFIG -----------------------------------------------------------------
# Bang Phli / Bang Na pilot. To scale up, widen this box (bigger = slower + more tiles).
#   Bangkok metro would be roughly: W,S,E,N = 100.25, 13.45, 100.95, 14.15
BBOX = dict(W=100.63, S=13.60, E=100.73, N=13.69)

MIN_CONFIDENCE = 0.70   # drop low-confidence AI detections
MIN_AREA_M2    = 15     # drop tiny structures (sheds, toilets) — keep real houses
TILE           = 0.01   # tile size in degrees (~1.1 km). MUST match OB_TILE in map-mode.js
OUTDIR         = os.path.join(os.path.dirname(__file__), "..", "..", "buildings")

PARQUET = ("s3://us-west-2.opendata.source.coop/vida/google-microsoft-open-buildings"
           "/geoparquet/by_country_s2/country_iso=THA/*.parquet")
# -----------------------------------------------------------------------------


def connect():
    con = duckdb.connect()
    con.sql("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;")
    con.sql("SET s3_region='us-west-2';")
    con.sql("SET s3_url_style='path';")   # <- the SSL fix
    try:
        con.sql("CREATE SECRET ob (TYPE s3, PROVIDER config, KEY_ID '', SECRET '', REGION 'us-west-2');")
    except Exception:
        pass
    return con


def extract(con):
    b = BBOX
    q = f"""
    SELECT round((bbox.ymin+bbox.ymax)/2, 6) AS lat,
           round((bbox.xmin+bbox.xmax)/2, 6) AS lon
    FROM read_parquet('{PARQUET}')
    WHERE bbox.xmin < {b['E']} AND bbox.xmax > {b['W']}
      AND bbox.ymin < {b['N']} AND bbox.ymax > {b['S']}
      AND ((bbox.xmin+bbox.xmax)/2) BETWEEN {b['W']} AND {b['E']}
      AND ((bbox.ymin+bbox.ymax)/2) BETWEEN {b['S']} AND {b['N']}
      AND confidence >= {MIN_CONFIDENCE} AND area_in_meters >= {MIN_AREA_M2}
    """
    t0 = time.time()
    print("Extracting from Open Buildings (remote)...")
    rows = con.sql(q).fetchall()
    print(f"  {len(rows)} buildings in {time.time()-t0:.0f}s")
    return rows


def tile(rows):
    tiles = {}
    for lat, lon in rows:
        key = (int(math.floor(lon / TILE)), int(math.floor(lat / TILE)))
        tiles.setdefault(key, []).append([lat, lon])

    os.makedirs(OUTDIR, exist_ok=True)
    # Only clear tiles we are about to overwrite — keeps other regions intact.
    written = 0
    for (tx, ty), pts in tiles.items():
        with open(os.path.join(OUTDIR, f"{tx}_{ty}.json"), "w") as f:
            json.dump(pts, f, separators=(",", ":"))
        written += 1
    print(f"  wrote {written} tiles to {os.path.normpath(OUTDIR)}")


if __name__ == "__main__":
    con = connect()
    rows = extract(con)
    if rows:
        tile(rows)
    print("Done.")
