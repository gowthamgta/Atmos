"""
Builds the Tamil Nadu terrain inset (the finer terrain the forecast fields are adjusted with): the Copernicus DEM (GLO-30, 30 m) averaged to 90 m.

  public/data/tn-elevation-90m.png   terrain on a 1/1200 deg (~90 m) grid, same encoding as sa-elevation-1km.png:
                                     metres = (R * 256 + G) / 65535 * 4000, land fraction = B / 255 (sea is 0 m, B = 0)
  public/data/tn-terrain.json        grid geometry (latMax, latMin, lonMin, lonMax, step, nx, ny) and the value range

The DEM is read from the public Copernicus bucket (copernicus-dem-30m, 1 degree tiles, CC BY 4.0 with attribution
"Copernicus DEM, © DLR and Airbus"). Tiles are cached in --cache so re-running does not download them again.

The 30 m grid is averaged 3 x 3 into 90 m cells; the land fraction is the share of land (elevation above 0 m) in each cell,
so the coastline is smooth instead of stair-stepped. Tamil Nadu plus a margin is covered, so the app can blend across the
state border with the 1 km grid it already has.

  pip install imagecodecs tifffile pillow numpy
  python scripts/build-tamil-nadu-dem.py --cache C:/Temp/dem
"""
from __future__ import annotations
import argparse, json, os, sys, urllib.request

import numpy as np
import tifffile
from concurrent.futures import ThreadPoolExecutor
from PIL import Image

# Tamil Nadu with a margin, in degrees; the grid is aligned to 1/1200 degree so 3 x 30 m cells make one 90 m cell
LAT_MAX, LAT_MIN = 13.65, 7.95
LON_MIN, LON_MAX = 76.10, 80.45
PER_DEG = 3600            # 30 m cells per degree
STEP_DEG = 1.0 / 1200.0   # 90 m
MAX_M = 4000.0            # the encoding range
BUCKET = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "data")


def tile_name(lat: int, lon: int) -> str:
    """Copernicus tile whose south-west corner is (lat, lon), e.g. N11 E079."""
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    base = f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"
    return base


def fetch_tile(lat: int, lon: int, cache: str) -> str | None:
    """Path of the tile's file in the cache, downloading it first if needed (safe to call from several threads).
    None when the bucket has no tile there: open sea, which the land mask treats as 0 m."""
    name = tile_name(lat, lon)
    path = os.path.join(cache, name + ".tif")
    absent = os.path.join(cache, name + ".none")
    if os.path.exists(absent):
        return None
    if not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)
        url = f"{BUCKET}/{name}/{name}.tif"
        print(f"  downloading {name}", flush=True)
        try:
            urllib.request.urlretrieve(url, path + ".part")
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            open(absent, "w").close()
            print(f"  {name}: no tile (open sea)", flush=True)
            return None
        os.replace(path + ".part", path)
    return path


def load_tile(lat: int, lon: int, cache: str) -> np.ndarray:
    path = fetch_tile(lat, lon, cache)
    if path is None:
        return np.zeros((PER_DEG, PER_DEG), np.float32)
    a = tifffile.imread(path).astype(np.float32)
    return np.nan_to_num(a, nan=0.0)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".dem-cache"), help="where the downloaded tiles are kept (git-ignored)")
    ap.add_argument("--out", default=OUT_DIR)
    args = ap.parse_args()

    top = int(np.ceil(LAT_MAX))           # tile row whose north edge is `top`
    # 30 m row / column indices of the bounds, measured from the north-west corner of the first tile
    row0 = round((top - LAT_MAX) * PER_DEG)
    row1 = round((top - LAT_MIN) * PER_DEG)
    col0 = round((LON_MIN - np.floor(LON_MIN)) * PER_DEG)
    lon_first = int(np.floor(LON_MIN))
    cols_total = round((LON_MAX - lon_first) * PER_DEG)
    ntile_lon = int(np.ceil(cols_total / PER_DEG))
    nrows_out = (row1 - row0) // 3
    ncols_out = (cols_total - col0) // 3
    print(f"grid: {nrows_out} x {ncols_out} cells of 90 m", flush=True)

    out_z = np.zeros((nrows_out, ncols_out), np.float32)
    out_land = np.zeros((nrows_out, ncols_out), np.float32)
    # fetch every tile in parallel first (the bucket is slow per connection), then process one band at a time
    tiles = [(band_top - 1, lon_first + k) for band_top in range(top, int(np.floor(LAT_MIN)), -1) for k in range(ntile_lon)]
    with ThreadPoolExecutor(8) as pool:
        list(pool.map(lambda t: fetch_tile(t[0], t[1], args.cache), tiles))
    # process one degree band at a time (5 tiles side by side, 3600 x 18000 values at most)
    for band_top in range(top, int(np.floor(LAT_MIN)), -1):
        band_lat = band_top - 1
        strip = np.hstack([load_tile(band_lat, lon_first + k, args.cache) for k in range(ntile_lon)])
        band_row0 = (top - band_top) * PER_DEG          # 30 m row where this band starts
        r_lo = max(row0, band_row0)
        r_hi = min(row1, band_row0 + PER_DEG)
        if r_lo >= r_hi:
            continue
        block = strip[r_lo - band_row0:r_hi - band_row0, col0:col0 + cols_total - col0]
        # each 90 m cell is a 3 x 3 block of 30 m cells (the bounds are aligned so the blocks fit)
        h = block.shape[0] // 3 * 3
        w = block.shape[1] // 3 * 3
        block = block[:h, :w]
        z = np.clip(block, 0, MAX_M).reshape(h // 3, 3, w // 3, 3)
        land = (block > 0).astype(np.float32).reshape(h // 3, 3, w // 3, 3)
        o_row = (r_lo - row0) // 3
        out_z[o_row:o_row + h // 3, :w // 3] = z.mean(axis=(1, 3))
        out_land[o_row:o_row + h // 3, :w // 3] = land.mean(axis=(1, 3))
        print(f"  band {band_lat}..{band_top} done", flush=True)

    r = np.clip(np.round(out_z / MAX_M * 65535), 0, 65535).astype(np.uint32)
    rgb = np.zeros((nrows_out, ncols_out, 3), np.uint8)
    rgb[..., 0] = (r // 256).astype(np.uint8)
    rgb[..., 1] = (r % 256).astype(np.uint8)
    rgb[..., 2] = np.round(out_land * 255).astype(np.uint8)
    os.makedirs(args.out, exist_ok=True)
    Image.fromarray(rgb).save(os.path.join(args.out, "tn-elevation-90m.png"), optimize=True)
    lon_min_out = lon_first + col0 / PER_DEG
    lat_max_out = top - row0 / PER_DEG
    meta = {
        "latMax": round(lat_max_out, 6),
        "latMin": round(lat_max_out - nrows_out * STEP_DEG, 6),
        "lonMin": round(lon_min_out, 6),
        "lonMax": round(lon_min_out + ncols_out * STEP_DEG, 6),
        "step": STEP_DEG,
        "nx": ncols_out,
        "ny": nrows_out,
        "min": 0,
        "max": MAX_M,
        "source": "Copernicus DEM GLO-30, 30 m averaged to 90 m; © DLR and Airbus",
    }
    with open(os.path.join(args.out, "tn-terrain.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(f"wrote {nrows_out} x {ncols_out} to {args.out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
