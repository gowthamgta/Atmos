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

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import ai_model.config as AIC


def build_static_grid(tiles_dir: str | None = None) -> dict[str, np.ndarray]:
    """Stitch 1-degree L2 terrain tiles into full domain 1km grids."""
    if tiles_dir is None:
        tiles_dir = getattr(AIC, "TERRAIN_TILES_DIR", os.path.join(AIC.PROJECT_ROOT, "pipeline", "data", "terrain", "L2"))

    n_per_deg = 100
    n_lat_deg = int(AIC.LAT_MAX - AIC.LAT_MIN)  # 18
    n_lon_deg = int(AIC.LON_MAX - AIC.LON_MIN)  # 29
    ny = n_lat_deg * n_per_deg  # 1800
    nx = n_lon_deg * n_per_deg  # 2900

    print(f"Building 1km static domain: {ny}x{nx} cells ({AIC.LAT_MIN}-{AIC.LAT_MAX}°N, {AIC.LON_MIN}-{AIC.LON_MAX}°E)...", flush=True)
    elevation = np.zeros((ny, nx), dtype=np.float32)
    land_mask = np.zeros((ny, nx), dtype=np.float32)

    found_tiles = 0
    if os.path.exists(tiles_dir):
        for lat in range(int(AIC.LAT_MIN), int(AIC.LAT_MAX)):
            for lon in range(int(AIC.LON_MIN), int(AIC.LON_MAX)):
                tile_name = f"N{lat:02d}E{lon:03d}.webp"
                tile_path = os.path.join(tiles_dir, tile_name)
                if not os.path.exists(tile_path):
                    # Open sea
                    continue

                found_tiles += 1
                try:
                    im = Image.open(tile_path)
                    arr = np.asarray(im)
                    r = arr[:, :, 0].astype(np.float32)
                    g = arr[:, :, 1].astype(np.float32)
                    b = arr[:, :, 2].astype(np.float32)

                    # Copernicus DEM decoding
                    tile_elev = (r * 256.0 + g) / 65535.0 * 4000.0
                    tile_land = b / 255.0

                    # Compute slice indices
                    r0 = (int(AIC.LAT_MAX) - 1 - lat) * n_per_deg
                    r1 = r0 + n_per_deg
                    c0 = (lon - int(AIC.LON_MIN)) * n_per_deg
                    c1 = c0 + n_per_deg

                    elevation[r0:r1, c0:c1] = tile_elev
                    land_mask[r0:r1, c0:c1] = tile_land
                except Exception:
                    pass

    print(f"Loaded {found_tiles} terrain tiles from {tiles_dir}.", flush=True)

    # Compute physical topographic gradients
    cell_size_m = 1080.0  # ~1.08 km per 0.01 degree
    gy, gx = np.gradient(elevation, cell_size_m, cell_size_m)
    slope_x = np.clip(gx, -0.25, 0.25).astype(np.float32)
    slope_y = np.clip(gy, -0.25, 0.25).astype(np.float32)

    # Continuous positional coordinates
    lats = np.linspace(AIC.LAT_MAX, AIC.LAT_MIN, ny, dtype=np.float32)
    lons = np.linspace(AIC.LON_MIN, AIC.LON_MAX, nx, dtype=np.float32)
    lon_grid, lat_grid = np.meshgrid(lons, lats)
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
    parser.add_argument("--output", default=getattr(AIC, "STATIC_1KM_FILE", "ai_model/data/static_1km.npz"), help="Target .npz file")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    tensors = build_static_grid()

    print(f"Saving static tensors to {args.output}...", flush=True)
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
    print(f"Done! Static physical tensor file: {size_mb:.2f} MB", flush=True)


if __name__ == "__main__":
    main()
