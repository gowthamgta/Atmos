"""Build 1km Static Physical Tensors (Copernicus DEM 90m -> 1km, Slopes, Land-Sea Mask, Positional Coordinates).

Stitches the 198 L2 terrain tiles (100 cells/deg) into unified physical conditioning tensors:
- elevation (m)
- land_mask (0=sea, 1=land)
- slope_x, slope_y (topographic gradient / orographic lift vectors)
- sin_lat, cos_lon (continuous spatial coordinates)

Usage:
  python ai_model/data/build_static_1km.py [--output <path>]
"""
from __future__ import annotations
import argparse, os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import config as C


def build_static_grid(tiles_dir: str = C.TERRAIN_TILES_DIR) -> dict[str, np.ndarray]:
    """Stitch 1-degree L2 terrain tiles into full domain 1km grids."""
    n_per_deg = 100
    n_lat_deg = int(C.LAT_MAX - C.LAT_MIN)  # 18
    n_lon_deg = int(C.LON_MAX - C.LON_MIN)  # 29
    ny = n_lat_deg * n_per_deg  # 1800
    nx = n_lon_deg * n_per_deg  # 2900

    print(f"Building 1km static domain: {ny}x{nx} cells ({C.LAT_MIN}-{C.LAT_MAX}°N, {C.LON_MIN}-{C.LON_MAX}°E)...")
    elevation = np.zeros((ny, nx), dtype=np.float32)
    land_mask = np.zeros((ny, nx), dtype=np.float32)

    found_tiles = 0
    for lat in range(int(C.LAT_MIN), int(C.LAT_MAX)):
        for lon in range(int(C.LON_MIN), int(C.LON_MAX)):
            tile_name = f"N{lat:02d}E{lon:03d}.webp"
            tile_path = os.path.join(tiles_dir, tile_name)
            if not os.path.exists(tile_path):
                # Open sea
                continue

            found_tiles += 1
            im = Image.open(tile_path)
            arr = np.asarray(im)
            r = arr[:, :, 0].astype(np.float32)
            g = arr[:, :, 1].astype(np.float32)
            b = arr[:, :, 2].astype(np.float32)

            # Copernicus DEM decoding
            tile_elev = (r * 256.0 + g) / 65535.0 * 4000.0
            tile_land = b / 255.0

            # Compute slice indices
            r0 = (int(C.LAT_MAX) - 1 - lat) * n_per_deg
            r1 = r0 + n_per_deg
            c0 = (lon - int(C.LON_MIN)) * n_per_deg
            c1 = c0 + n_per_deg

            elevation[r0:r1, c0:c1] = tile_elev
            land_mask[r0:r1, c0:c1] = tile_land

    print(f"Loaded {found_tiles} land tiles (remaining cells are open sea).")
    print(f"Elevation min: {elevation.min():.1f}m, max: {elevation.max():.1f}m (Anamudi / Western Ghats peaks).")
    print(f"Land fraction: {(land_mask > 0.5).mean() * 100:.1f}% of domain is land.")

    # Topographic Gradients / Slopes (driving orographic precipitation & rain shadow)
    # Cell size at 1km is ~1000m
    dy = 111139.0 / n_per_deg  # ~1111m per cell north-south
    lats = np.linspace(C.LAT_MAX, C.LAT_MIN, ny)
    lons = np.linspace(C.LON_MIN, C.LON_MAX, nx)
    lon_grid, lat_grid = np.meshgrid(lons, lats)

    dx = (111139.0 * np.cos(np.radians(lat_grid))) / n_per_deg  # zonal cell size in metres

    grad_y, grad_x = np.gradient(elevation)
    slope_y = grad_y / dy  # rise / run (meridional slope)
    slope_x = grad_x / np.maximum(dx, 100.0)  # rise / run (zonal slope)

    # Normalize continuous coordinate encodings
    sin_lat = np.sin(np.radians(lat_grid)).astype(np.float32)
    cos_lon = np.cos(np.radians(lon_grid)).astype(np.float32)

    return {
        "elevation": elevation.astype(np.float32),
        "land_mask": land_mask.astype(np.float32),
        "slope_x": slope_x.astype(np.float32),
        "slope_y": slope_y.astype(np.float32),
        "sin_lat": sin_lat,
        "cos_lon": cos_lon,
    }


def main():
    parser = argparse.ArgumentParser(description="Extract 1km static physical tensors for Kralveth AI")
    parser.add_argument("--output", default=C.STATIC_1KM_FILE, help="Target .npz file")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    tensors = build_static_grid()

    print(f"Saving static tensors to {args.output}...")
    np.savez_compressed(
        args.output,
        elevation=tensors["elevation"],
        land_mask=tensors["land_mask"],
        slope_x=tensors["slope_x"],
        slope_y=tensors["slope_y"],
        sin_lat=tensors["sin_lat"],
        cos_lon=tensors["cos_lon"],
    )
    size_mb = os.path.getsize(args.output) / (1024 * 1024)
    print(f"Done! Static physical tensor file: {size_mb:.2f} MB")


if __name__ == "__main__":
    main()
