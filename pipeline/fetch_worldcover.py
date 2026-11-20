"""ESA WorldCover (10 m) fetcher and 90 m/100 m sampler for Atmos.

Downloads and samples the European Space Agency (ESA) WorldCover 10 m land cover dataset
(2021 v200) from the public AWS S3 bucket (s3://esa-worldcover/v200/2021/map/).
The dataset is hosted as Cloud-Optimized GeoTIFFs (COGs) on a 3° x 3° grid.

Classes:
  10: Tree cover (Forests, groves, dense vegetation)
  20: Shrubland
  30: Grassland
  40: Cropland (Paddy, sugarcane, farmlands)
  50: Built-up (Towns, buildings, settlements, concrete)
  60: Bare / sparse vegetation (Rock, dry soil)
  70: Snow and ice
  80: Permanent water bodies (Lakes, reservoirs, eris, rivers)
  90: Herbaceous wetland
  95: Mangroves
 100: Moss and lichen

This module samples the 3° x 3° COGs to 1° x 1° tiles matching Atmos's terrain grid:
  - L0 (90 m): 1200 x 1200 cells
  - L1 (270 m): 400 x 400 cells
  - L2 (1.08 km): 100 x 100 cells
"""
from __future__ import annotations
import argparse, math, os, sys, time, urllib.error, urllib.request
from typing import Dict, Tuple

import numpy as np
from PIL import Image
import fsspec
import tifffile

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, "cache", "worldcover")
S3_BASE = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map"

# Official ESA WorldCover RGB color palette for previews and visualization
ESA_PALETTE: Dict[int, Tuple[int, int, int]] = {
    0: (0, 0, 0),         # Sea / No data
    10: (0, 100, 0),      # Tree cover (Forest)
    20: (255, 187, 34),   # Shrubland
    30: (255, 255, 76),   # Grassland
    40: (240, 150, 255),  # Cropland
    50: (250, 0, 0),      # Built-up / Buildings
    60: (180, 180, 180),  # Bare / sparse
    70: (240, 240, 240),  # Snow / ice
    80: (0, 100, 200),    # Water bodies
    90: (0, 150, 160),    # Herbaceous wetland
    95: (0, 207, 117),    # Mangroves
    100: (250, 230, 160), # Moss / lichen
}

ESA_NAMES: Dict[int, str] = {
    0: "Sea / Open Water",
    10: "Tree Cover / Forest",
    20: "Shrubland",
    30: "Grassland",
    40: "Cropland / Farmland",
    50: "Built-up / Buildings",
    60: "Bare / Sparse Vegetation",
    70: "Snow / Ice",
    80: "Inland Water Bodies",
    90: "Herbaceous Wetland",
    95: "Mangroves",
    100: "Moss / Lichen",
}


def worldcover_cog_name(lat: int, lon: int) -> tuple[int, int, str]:
    """Finds the 3° x 3° COG south-west corner and filename covering (lat, lon)."""
    sw_lat = (lat // 3) * 3
    sw_lon = (lon // 3) * 3
    cog_name = f"ESA_WorldCover_10m_2021_v200_N{sw_lat:02d}E{sw_lon:03d}_Map.tif"
    return sw_lat, sw_lon, cog_name


def fetch_worldcover_cog_subgrid(sw_lat: int, sw_lon: int, cog_name: str, cache_dir: str = CACHE_DIR, page: int = 3) -> np.ndarray | None:
    """Fetches the 1500 x 1500 per degree overview (Page 3: 4500x4500 for 3°x3°) or Page 2 for a 3° x 3° block."""
    os.makedirs(cache_dir, exist_ok=True)
    # Check for existing cache (either page 3 or page 2)
    cache_path_p3 = os.path.join(cache_dir, f"{cog_name}_p3.npy")
    cache_path_orig = os.path.join(cache_dir, f"{cog_name}.npy")
    if os.path.exists(cache_path_p3):
        return np.load(cache_path_p3)
    if os.path.exists(cache_path_orig):
        return np.load(cache_path_orig)

    url = f"{S3_BASE}/{cog_name}"
    tmp_tif = os.path.join(cache_dir, f"{cog_name}.tmp.tif")
    try:
        # Stream the GeoTIFF in a single HTTP request for 10x throughput over individual range seeks
        urllib.request.urlretrieve(url, tmp_tif)
        with tifffile.TiffFile(tmp_tif) as tif:
            arr = tif.pages[page].asarray().astype(np.uint8)
            target_cache = cache_path_p3 if page == 3 else cache_path_orig
            np.save(target_cache, arr)
            return arr
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        print(f"  [worldcover] HTTP error {e.code} for {cog_name}", flush=True)
        return None
    except Exception as e:
        print(f"  [worldcover] Note: {cog_name} not available or sea: {e}", flush=True)
        return None
    finally:
        if os.path.exists(tmp_tif):
            try:
                os.remove(tmp_tif)
            except Exception:
                pass


def get_worldcover_1deg(lat: int, lon: int, per_deg: int = 1200, cache_dir: str = CACHE_DIR) -> np.ndarray | None:
    """Samples land cover for a 1° x 1° tile [lat, lat+1) N x [lon, lon+1) E.
    
    Returns an array of shape (per_deg, per_deg) with ESA WorldCover class values (uint8),
    or None if the entire tile is open sea.
    """
    sw_lat, sw_lon, cog_name = worldcover_cog_name(lat, lon)
    full_3deg = fetch_worldcover_cog_subgrid(sw_lat, sw_lon, cog_name, cache_dir)
    if full_3deg is None:
        return None

    # Dynamically determine cells per degree from the loaded array
    cells_per_deg = full_3deg.shape[0] // 3
    # Rows: Row 0 is north (sw_lat + 3).
    # lat is between sw_lat and sw_lat + 2.
    # row_offset from top: (sw_lat + 2 - lat) * cells_per_deg
    r0 = (sw_lat + 2 - lat) * cells_per_deg
    r1 = r0 + cells_per_deg
    # Cols: Col 0 is west (sw_lon).
    # col_offset from left: (lon - sw_lon) * cells_per_deg
    c0 = (lon - sw_lon) * cells_per_deg
    c1 = c0 + cells_per_deg

    sub_deg = full_3deg[r0:r1, c0:c1]
    if sub_deg.size == 0 or np.all(sub_deg == 0):
        return None

    if per_deg == cells_per_deg:
        return sub_deg

    # Nearest-neighbor resize to preserve categorical class IDs exactly
    im = Image.fromarray(sub_deg)
    resized = im.resize((per_deg, per_deg), Image.Resampling.NEAREST)
    return np.array(resized, dtype=np.uint8)


def render_preview_rgb(classes: np.ndarray) -> np.ndarray:
    """Renders a land cover class array (uint8) into an RGB image array."""
    h, w = classes.shape
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    for cls_val, color in ESA_PALETTE.items():
        mask = (classes == cls_val)
        rgb[mask] = color
    return rgb


def summarize_classes(classes: np.ndarray) -> Dict[str, float]:
    """Calculates percentage breakdown of land cover classes."""
    total = classes.size
    vals, counts = np.unique(classes, return_counts=True)
    summary: Dict[str, float] = {}
    for v, count in zip(vals, counts):
        name = ESA_NAMES.get(int(v), f"Class {v}")
        summary[name] = round((count / total) * 100.0, 2)
    return summary


def main():
    parser = argparse.ArgumentParser(description="Fetch and sample ESA WorldCover 10m land cover.")
    parser.add_argument("--lat", type=int, default=11, help="Tile south-west latitude (default: 11 for Kallakurichi/Salem)")
    parser.add_argument("--lon", type=int, default=78, help="Tile south-west longitude (default: 78 for Kallakurichi/Salem)")
    parser.add_argument("--res", type=int, default=1200, help="Cells per degree (1200 for 90m, 400 for 270m, 100 for 1km)")
    parser.add_argument("--out", type=str, default="cache/worldcover", help="Output directory")
    parser.add_argument("--preview", action="store_true", help="Generate a color-coded PNG preview image")
    args = parser.parse_args()

    tile_name = f"N{args.lat:02d}E{args.lon:03d}"
    print(f"Fetching ESA WorldCover for tile {tile_name} at {args.res}x{args.res} resolution...")
    t0 = time.time()
    lc = get_worldcover_1deg(args.lat, args.lon, per_deg=args.res, cache_dir=args.out)
    dt = time.time() - t0

    if lc is None:
        print(f"Tile {tile_name} is open water or no data available.")
        return

    print(f"Sampled {tile_name} in {dt:.2f}s. Breakdown:")
    stats = summarize_classes(lc)
    for name, pct in sorted(stats.items(), key=lambda x: -x[1]):
        print(f"  {name:30s}: {pct:5.2f}%")

    if args.preview:
        rgb = render_preview_rgb(lc)
        preview_file = os.path.join(args.out, f"{tile_name}_preview.png")
        Image.fromarray(rgb).save(preview_file)
        print(f"Preview saved to: {preview_file}")


if __name__ == "__main__":
    main()
