#!/usr/bin/env python3
"""
Build static building tiles from Google-Microsoft Open Buildings (VIDA dataset).

Pipeline: query the remote GeoParquet for a bounding box -> filter to "real houses"
-> split building centroids into a 0.01-degree tile grid -> write /buildings/{tx}_{ty}.json

The app fetches only the tiles overlapping the area you draw, so counting stays fast
no matter how big the full dataset is.

USAGE
    pip install duckdb
    python build_tiles.py                       # default: Bang Phli pilot
    python build_tiles.py 100.25 13.45 100.95 14.15   # W S E N : Bangkok metro

The extraction STREAMS results (ORDER BY tile, write each tile as it completes) so it
uses little memory even for millions of buildings.

Learned notes (why the code looks like this):
  - SET s3_url_style='path'   -> bucket name has dots; virtual-host URL breaks SSL cert
  - the `bbox` column lets us filter by area WITHOUT decoding WKB geometry (and it
    prunes row groups, so DuckDB only downloads the parts we need)
  - centroid = midpoint of bbox = ((xmin+xmax)/2, (ymin+ymax)/2)
"""
import duckdb, json, os, sys, time

# ---- CONFIG -----------------------------------------------------------------
# Bang Phli / Bang Na pilot by default. Pass W S E N on the command line to override.
#   Bangkok metro:  100.25 13.45 100.95 14.15
BBOX = dict(W=100.63, S=13.60, E=100.73, N=13.69)
if len(sys.argv) == 5:
    BBOX = dict(W=float(sys.argv[1]), S=float(sys.argv[2]), E=float(sys.argv[3]), N=float(sys.argv[4]))

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


def build(con):
    b = BBOX
    # Compute the tile id in SQL and ORDER BY it so all points of a tile arrive together.
    q = f"""
    SELECT floor(((bbox.xmin+bbox.xmax)/2)/{TILE})::int AS tx,
           floor(((bbox.ymin+bbox.ymax)/2)/{TILE})::int AS ty,
           round((bbox.ymin+bbox.ymax)/2, 6) AS lat,
           round((bbox.xmin+bbox.xmax)/2, 6) AS lon
    FROM read_parquet('{PARQUET}')
    WHERE bbox.xmin < {b['E']} AND bbox.xmax > {b['W']}
      AND bbox.ymin < {b['N']} AND bbox.ymax > {b['S']}
      AND ((bbox.xmin+bbox.xmax)/2) BETWEEN {b['W']} AND {b['E']}
      AND ((bbox.ymin+bbox.ymax)/2) BETWEEN {b['S']} AND {b['N']}
      AND confidence >= {MIN_CONFIDENCE} AND area_in_meters >= {MIN_AREA_M2}
    ORDER BY tx, ty
    """
    os.makedirs(OUTDIR, exist_ok=True)

    def write_tile(tx, ty, pts):
        with open(os.path.join(OUTDIR, f"{tx}_{ty}.json"), "w") as f:
            json.dump(pts, f, separators=(",", ":"))

    t0 = time.time()
    print(f"Querying Open Buildings for {b} ...")
    con.execute(q)

    cur_key = None
    cur_pts = []
    tiles = 0
    total = 0
    while True:
        rows = con.fetchmany(100000)   # stream in chunks — bounded memory
        if not rows:
            break
        for tx, ty, lat, lon in rows:
            total += 1
            if (tx, ty) != cur_key:
                if cur_key is not None:
                    write_tile(cur_key[0], cur_key[1], cur_pts)
                    tiles += 1
                cur_key = (tx, ty)
                cur_pts = []
            cur_pts.append([lat, lon])
        print(f"  ...{total:,} buildings, {tiles:,} tiles ({time.time()-t0:.0f}s)")
    if cur_key is not None:
        write_tile(cur_key[0], cur_key[1], cur_pts)
        tiles += 1

    print(f"DONE: {total:,} buildings -> {tiles:,} tiles in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    build(connect())
