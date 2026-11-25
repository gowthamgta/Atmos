"""Builds compact global terrain images (0.1 deg fine & 0.25 deg model ground) from AWS Open Data Terrarium tiles.

Writes:
  pipeline/data/terrain/global.webp        (0.1 deg, 1701 x 3600, -85..+85 lat, -180..+179.9 lon)
  pipeline/data/terrain/global_model.webp  (0.25 deg, 681 x 1440, -85..+85 lat, -180..+179.75 lon)
and updates pipeline/data/terrain/index.json with the `global` metadata block.
"""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
import io
import json
import math
import os
import numpy as np
from PIL import Image
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "data", "terrain")
TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
ZOOM = 4
MAX_M = 6000.0


def _fetch_tile(args: tuple[int, int, int]) -> tuple[int, int, np.ndarray]:
    z, x, y = args
    r = requests.get(TERRARIUM_URL.format(z=z, x=x, y=y), timeout=20)
    r.raise_for_status()
    arr = np.array(Image.open(io.BytesIO(r.content)).convert("RGB"), dtype=np.float32)
    elev = (arr[..., 0] * 256.0 + arr[..., 1] + arr[..., 2] / 256.0) - 32768.0
    return x, y, elev


def build_global_dem(lat_min: float = -85.0, lat_max: float = 85.0, step: float = 0.1) -> tuple[np.ndarray, np.ndarray]:
    n_tiles = 1 << ZOOM
    tile_px = 256
    mosaic = np.zeros((n_tiles * tile_px, n_tiles * tile_px), dtype=np.float32)
    jobs = [(ZOOM, x, y) for y in range(n_tiles) for x in range(n_tiles)]
    with ThreadPoolExecutor(16) as pool:
        for x, y, elev in pool.map(_fetch_tile, jobs):
            mosaic[y * tile_px:(y + 1) * tile_px, x * tile_px:(x + 1) * tile_px] = elev

    ny = round((lat_max - lat_min) / step) + 1
    nx = round(360.0 / step)
    lats = lat_max - step * np.arange(ny)
    lons = -180.0 + step * np.arange(nx)

    total_px = n_tiles * tile_px
    # Web Mercator pixel coordinates
    lat_rad = np.radians(np.clip(lats, -85.0511, 85.0511))
    my = (1.0 - np.log(np.tan(lat_rad) + 1.0 / np.cos(lat_rad)) / math.pi) * 0.5 * total_px
    mx = ((lons + 180.0) / 360.0) * total_px

    iy = np.clip(np.round(my).astype(int), 0, total_px - 1)[:, None]
    ix = np.clip(np.round(mx).astype(int), 0, total_px - 1)[None, :]
    dem = mosaic[iy, ix]
    land = (dem > 0.0).astype(np.float32)
    dem = np.clip(dem, 0.0, MAX_M)
    return dem, land


def encode_dem_webp(dem: np.ndarray, land: np.ndarray, path: str, max_m: float = MAX_M) -> None:
    q = np.clip(np.round(np.clip(dem, 0.0, max_m) / max_m * 65535.0), 0, 65535).astype(np.uint32)
    rgba = np.zeros(dem.shape + (4,), dtype=np.uint8)
    rgba[..., 0] = (q // 256).astype(np.uint8)
    rgba[..., 1] = (q % 256).astype(np.uint8)
    rgba[..., 2] = np.clip(np.round(land * 255.0), 0, 255).astype(np.uint8)
    rgba[..., 3] = 255
    Image.fromarray(rgba, "RGBA").save(path, "WEBP", lossless=True, method=4)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    print("Downloading Terrarium z=4 global elevation tiles (256 tiles)...", flush=True)
    dem_fine, land_fine = build_global_dem(lat_min=-85.0, lat_max=85.0, step=0.1)
    fine_path = os.path.join(OUT_DIR, "global.webp")
    encode_dem_webp(dem_fine, land_fine, fine_path)

    dem_model, land_model = build_global_dem(lat_min=-85.0, lat_max=85.0, step=0.25)
    model_path = os.path.join(OUT_DIR, "global_model.webp")
    encode_dem_webp(dem_model, land_model, model_path)

    idx_path = os.path.join(OUT_DIR, "index.json")
    if os.path.exists(idx_path):
        with open(idx_path, "r", encoding="utf-8") as f:
            idx = json.load(f)
        idx["global"] = {
            "min": 0,
            "max": int(MAX_M),
            "fine": {
                "file": "global.webp",
                "latMax": 85.0, "latMin": -85.0, "lonMin": -180.0, "lonMax": 179.9,
                "step": 0.1, "nx": dem_fine.shape[1], "ny": dem_fine.shape[0],
            },
            "model": {
                "file": "global_model.webp",
                "latMax": 85.0, "latMin": -85.0, "lonMin": -180.0, "lonMax": 179.75,
                "step": 0.25, "nx": dem_model.shape[1], "ny": dem_model.shape[0],
            },
        }
        with open(idx_path, "w", encoding="utf-8") as f:
            json.dump(idx, f, indent=2)
    print(f"Saved global.webp ({os.path.getsize(fine_path)//1024} KB) and global_model.webp ({os.path.getsize(model_path)//1024} KB).", flush=True)


if __name__ == "__main__":
    main()
