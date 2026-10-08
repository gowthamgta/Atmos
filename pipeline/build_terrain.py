"""Terrain for the forecast domain, from the Copernicus DEM (GLO-30, 30 m), at 90 m.

The app draws the forecast fields adjusted to the ground (lapse rate, humidity, slopes, coast). The ground is stored as:

  public/data/terrain/L0/<tile>.webp   90 m: every 1 x 1 degree tile is 1200 x 1200 cells (the full resolution)
  public/data/terrain/L1/<tile>.webp   270 m: the same tiles averaged 3 x 3 (400 x 400)
  public/data/terrain/L2/<tile>.webp   1.08 km: averaged 12 x 12 (100 x 100)
  public/data/terrain/smooth.png       the ground smoothed over ~4 km, on the 0.05 degree grid
  public/data/terrain/model-<K>km.png  the ground as a K km model sees it (box mean over K km), on the forecast grid
  public/data/terrain/index.json       domain, tile list (a tile without a file is open sea), grids and value ranges

Each tile covers [lat, lat+1) x [lon, lon+1) and is named by its south-west corner, e.g. N11E078.
Tile pixels are cell centres: pixel (r, c) of a tile is at lat = lat + 1 - (r + 0.5) / n, lon = lon + (c + 0.5) / n.

Encoding of the tiles and the smooth/model grids (B is data, not a no-data flag):
  metres = (R * 256 + G) / 65535 * 4000,  land fraction = B / 255

The tiles are lossless WebP, so every value is kept exactly. The grids are 16-bit PNG.

Sources: Copernicus DEM GLO-30, downloaded from the public bucket (copernicus-dem-30m, CC BY 4.0; "© DLR and Airbus").
Tiles are cached in --cache, so re-running does not download them again. A tile the bucket does not have is open sea.

  python pipeline/build_terrain.py --cache C:/Temp/dem
Needs: numpy, Pillow, tifffile, imagecodecs, scipy
"""
from __future__ import annotations
import argparse, json, math, os, sys, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image
import tifffile
from scipy.ndimage import gaussian_filter, uniform_filter

import config as C

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "public", "data", "terrain")
BUCKET = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com"
MAX_M = 4000.0
SRC_PER_DEG = 3600                       # Copernicus cells per degree (30 m)
LEVELS = {0: 1200, 1: 400, 2: 100}       # cells per degree in each level: 90 m, 270 m, 1.08 km
SMOOTH_STEP = 0.05
SMOOTH_SIGMA_KM = 4.0
MODEL_KMS = (9, 10, 13, 28)              # native grid of the models the app offers (nearest one is used)


def tile_name(lat: int, lon: int) -> str:
    return f"N{lat:02d}E{lon:03d}"


def copernicus_name(lat: int, lon: int) -> str:
    ns, ew = ("N", "E")
    return f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"


def fetch_source(lat: int, lon: int, cache: str) -> str | None:
    """Path of the tile's DEM file, downloaded if needed (safe from several threads). None: the bucket has no tile (sea)."""
    name = copernicus_name(lat, lon)
    path = os.path.join(cache, name + ".tif")
    absent = os.path.join(cache, name + ".none")
    if os.path.exists(absent):
        return None
    if not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)
        try:
            print(f"  downloading {name}", flush=True)
            urllib.request.urlretrieve(f"{BUCKET}/{name}/{name}.tif", path + ".part")
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            open(absent, "w").close()
            return None
        os.replace(path + ".part", path)
    return path


def load_source(lat: int, lon: int, cache: str) -> np.ndarray | None:
    path = fetch_source(lat, lon, cache)
    if path is None:
        return None
    return np.nan_to_num(tifffile.imread(path).astype(np.float32), nan=0.0)


def process_tile(lat: int, lon: int, cache: str, out: str) -> tuple[int, int, np.ndarray, np.ndarray] | None:
    """Writes the tile's 90 m and 1.08 km files, and returns its 270 m level for the mosaic (None: open sea)."""
    src = load_source(lat, lon, cache)
    if src is None:
        return None
    levels = tile_levels(src)
    del src
    name = tile_name(lat, lon)
    for lvl, (z, land) in levels.items():
        if lvl == 1:
            continue
        folder = os.path.join(out, f"L{lvl}")
        os.makedirs(folder, exist_ok=True)
        Image.fromarray(encode_rgb(z, land)).save(os.path.join(folder, name + ".webp"), format="WEBP", lossless=True, method=6)
    folder = os.path.join(out, "L1")
    os.makedirs(folder, exist_ok=True)
    z1, l1 = levels[1]
    Image.fromarray(encode_rgb(z1, l1)).save(os.path.join(folder, name + ".webp"), format="WEBP", lossless=True, method=6)
    print(f"  {name}: land {float(l1.mean()):.2f}, highest {float(z1.max()):.0f} m", flush=True)
    return lat, lon, z1, l1


def block_mean(a: np.ndarray, k: int) -> np.ndarray:
    h, w = a.shape[0] // k * k, a.shape[1] // k * k
    return a[:h, :w].reshape(h // k, k, w // k, k).mean(axis=(1, 3)).astype(np.float32)


def tile_levels(src: np.ndarray) -> dict[int, tuple[np.ndarray, np.ndarray]]:
    """(elevation metres, land fraction) of one tile at each level. Land is elevation above sea level."""
    z = np.clip(src, 0.0, MAX_M)
    land = (src > 0).astype(np.float32)
    z0, l0 = block_mean(z, SRC_PER_DEG // LEVELS[0]), block_mean(land, SRC_PER_DEG // LEVELS[0])
    z1, l1 = block_mean(z0, LEVELS[0] // LEVELS[1]), block_mean(l0, LEVELS[0] // LEVELS[1])
    z2, l2 = block_mean(z1, LEVELS[1] // LEVELS[2]), block_mean(l1, LEVELS[1] // LEVELS[2])
    return {0: (z0, l0), 1: (z1, l1), 2: (z2, l2)}


def encode_rgb(metres: np.ndarray, land: np.ndarray) -> np.ndarray:
    q = np.clip(np.round(np.clip(metres, 0, MAX_M) / MAX_M * 65535), 0, 65535).astype(np.uint32)
    rgb = np.zeros(metres.shape + (3,), np.uint8)
    rgb[..., 0] = (q // 256).astype(np.uint8)
    rgb[..., 1] = (q % 256).astype(np.uint8)
    rgb[..., 2] = np.clip(np.round(land * 255), 0, 255).astype(np.uint8)
    return rgb


def tile_range() -> tuple[list[int], list[int]]:
    """Whole-degree rows (latitudes) and columns (longitudes) of tiles that cover the forecast domain."""
    lats = list(range(math.floor(C.LAT_MIN), math.ceil(C.LAT_MAX)))
    lons = list(range(math.floor(C.LON_MIN), math.ceil(C.LON_MAX)))
    return lats, lons


def sample(grid: np.ndarray, top: float, left: float, per_deg: int, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Nearest cell of a mosaic (its top-left corner at (top, left) degrees) at each latitude and longitude."""
    r = np.clip(np.round((top - lat) * per_deg - 0.5).astype(int), 0, grid.shape[0] - 1)
    c = np.clip(np.round((lon - left) * per_deg - 0.5).astype(int), 0, grid.shape[1] - 1)
    return grid[r, c]


def build(cache: str, out: str, workers: int) -> None:
    lats, lons = tile_range()
    todo = [(la, lo) for la in lats for lo in lons]
    print(f"domain {C.LAT_MIN}..{C.LAT_MAX} N, {C.LON_MIN}..{C.LON_MAX} E: {len(todo)} tiles to look at", flush=True)

    top = lats[-1] + 1                    # degrees north of the mosaic's first row
    left = lons[0]                        # degrees east of its first column
    mosaic_z = np.zeros(((top - lats[0]) * LEVELS[1], (lons[-1] + 1 - left) * LEVELS[1]), np.float32)
    mosaic_l = np.zeros_like(mosaic_z)
    present: list[str] = []
    with ThreadPoolExecutor(workers) as pool:
        for done in pool.map(lambda t: process_tile(t[0], t[1], cache, out), todo):
            if done is None:
                continue
            la, lo, z1, l1 = done
            present.append(tile_name(la, lo))
            r0 = (top - (la + 1)) * LEVELS[1]
            c0 = (lo - left) * LEVELS[1]
            mosaic_z[r0:r0 + LEVELS[1], c0:c0 + LEVELS[1]] = z1
            mosaic_l[r0:r0 + LEVELS[1], c0:c0 + LEVELS[1]] = l1

    # the smooth and model grids, on the forecast grid's nodes
    node_lat_s = C.LAT_MAX - SMOOTH_STEP * np.arange(round((C.LAT_MAX - C.LAT_MIN) / SMOOTH_STEP) + 1)
    node_lon_s = C.LON_MIN + SMOOTH_STEP * np.arange(round((C.LON_MAX - C.LON_MIN) / SMOOTH_STEP) + 1)
    px_km = LEVELS[1] / 111.2                # level-1 cells per km (about 3.6)
    sigma_cells = SMOOTH_SIGMA_KM * px_km
    smooth_z = gaussian_filter(mosaic_z, sigma=sigma_cells, mode="nearest")
    smooth_l = gaussian_filter(mosaic_l, sigma=sigma_cells, mode="nearest")
    la_g, lo_g = np.meshgrid(node_lat_s, node_lon_s, indexing="ij")
    write_grid(os.path.join(out, "smooth.png"),
               sample(smooth_z, top, left, LEVELS[1], la_g, lo_g), sample(smooth_l, top, left, LEVELS[1], la_g, lo_g))

    node_lat = C.LAT_MAX - C.STEP_DEG * np.arange(C.NY)
    node_lon = C.LON_MIN + C.STEP_DEG * np.arange(C.NX)
    la_m, lo_m = np.meshgrid(node_lat, node_lon, indexing="ij")
    model_grids = {}
    for km in MODEL_KMS:
        size = max(1, round(km * px_km))
        zb = uniform_filter(mosaic_z, size=size, mode="nearest")
        lb = uniform_filter(mosaic_l, size=size, mode="nearest")
        write_grid(os.path.join(out, f"model-{km}km.png"), sample(zb, top, left, LEVELS[1], la_m, lo_m), sample(lb, top, left, LEVELS[1], la_m, lo_m))
        model_grids[str(km)] = f"model-{km}km.png"

    index = {
        "version": 1,
        "domain": {"latMax": C.LAT_MAX, "latMin": C.LAT_MIN, "lonMin": C.LON_MIN, "lonMax": C.LON_MAX},
        "tileDeg": 1,
        "levels": [{"id": lvl, "perDeg": n, "dir": f"L{lvl}"} for lvl, n in LEVELS.items()],
        "tiles": sorted(present),
        "min": 0,
        "max": MAX_M,
        "smooth": {"file": "smooth.png", "latMax": float(node_lat_s[0]), "latMin": float(node_lat_s[-1]),
                   "lonMin": float(node_lon_s[0]), "lonMax": float(node_lon_s[-1]), "step": SMOOTH_STEP,
                   "nx": int(len(node_lon_s)), "ny": int(len(node_lat_s))},
        "grid": {"latMax": C.LAT_MAX, "latMin": C.LAT_MIN, "lonMin": C.LON_MIN, "lonMax": C.LON_MAX,
                 "step": C.STEP_DEG, "nx": C.NX, "ny": C.NY},
        "model": model_grids,
        "source": "Copernicus DEM GLO-30, 30 m averaged to 90 m, 270 m and 1.08 km; © DLR and Airbus",
    }
    with open(os.path.join(out, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, indent=1)
    print(f"wrote {len(present)} tiles, smooth and {len(MODEL_KMS)} model grids to {out}", flush=True)


def write_grid(path: str, metres: np.ndarray, land: np.ndarray) -> None:
    Image.fromarray(encode_rgb(metres, land)).save(path, optimize=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(HERE, "..", ".dem-cache"), help="downloaded DEM tiles (git-ignored)")
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    build(args.cache, args.out, args.workers)
    sys.exit(0)
