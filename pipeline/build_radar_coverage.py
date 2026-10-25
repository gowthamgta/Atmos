"""Bakes the map of where the IMD radars can see rain near the ground (a one-off, like build_terrain.py; the workflows do not run it).

Output, in public/data (served by the app itself, a few tens of kilobytes):
  radar-coverage.png    8-bit, one cell every 0.02 degrees: 0 no radar in range, 1 sees low rain poorly, 2 only partly, 3 well
  radar-coverage.json   the box and spacing of that picture, the radars it was made for, and the assumptions of the beam

For each radar, rays every half a degree are traced over the terrain (the 270 m level of the app's terrain, level L1): how high the beam is above
the ground at each kilometre, and how much of it the ground in front blocks (see radar_coverage.py). Each cell takes the best of the radars in
whose range it lies. When a radar is added to radar.model.ts, add it to STATIONS and run this again (a spec in the app checks the two agree;
the radar-coverage workflow runs it on GitHub).

  python pipeline/build_radar_coverage.py --cache C:/Temp/dem-l1
Needs: numpy, Pillow, scipy
"""
from __future__ import annotations

import argparse
import json
import math
import os
import tempfile
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates, median_filter

import radar_coverage as R

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "public", "data")
TERRAIN = "https://gowthamgta.github.io/Atmos/terrain/L1"   # published with the forecast by the nwp workflow (see build_terrain.py)
PER_DEG = 400                                              # cells per degree of an L1 tile (270 m)
MAX_M = 4000.0

# The IMD radars of src/app/core/domain/models/radar.model.ts whose column-maximum picture reaches this box: id, latitude, longitude, band,
# range of that picture (km). A spec in the app checks the list against the app's.
STATIONS = [
    ("karaikal", 10.9129, 79.8418, "S-Band", 250),
    ("chennai", 13.0839, 80.2901, "S-Band", 250),
    ("pallikaranai", 12.9451, 80.2115, "X-Band", 87),

    ("kochi", 9.9312, 76.2673, "S-Band", 255),
    ("thiruvananthapuram", 8.5374, 76.8657, "C-Band", 240),
    ("mangaluru", 12.901, 74.856, "C-Band", 250),
    ("goa", 15.4909, 73.8278, "S-Band", 250),
    ("hyderabad", 17.385, 78.4867, "S-Band", 250),
    ("visakhapatnam", 17.6868, 83.2185, "S-Band", 250),
]

SOUTH, NORTH, WEST, EAST, STEP = 5.8, 16.4, 72.0, 83.1, 0.02
TILE_LAT0, TILE_LAT1, TILE_LON0, TILE_LON1 = 5, 16, 72, 83      # the 1 degree tiles (by south-west corner) the 300 km rays can reach


def tile_name(lat: int, lon: int) -> str:
    return f"N{lat:02d}E{lon:03d}"


def fetch_tile(lat: int, lon: int, cache: str) -> np.ndarray | None:
    """Heights (m) of one L1 tile, or None for open sea (the terrain has no file there)."""
    name = tile_name(lat, lon)
    path = os.path.join(cache, name + ".webp")
    absent = os.path.join(cache, name + ".none")
    if os.path.exists(absent):
        return None
    if not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)
        try:
            urllib.request.urlretrieve(f"{TERRAIN}/{name}.webp", path + ".part")
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            open(absent, "w").close()
            return None
        os.replace(path + ".part", path)
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)
    return (rgb[..., 0] * 256.0 + rgb[..., 1]) / 65535.0 * MAX_M


def build_mosaic(cache: str) -> np.ndarray:
    """The terrain of the whole box as one array, north at the top; open sea is 0 m."""
    n_lat = TILE_LAT1 - TILE_LAT0 + 1
    n_lon = TILE_LON1 - TILE_LON0 + 1
    mosaic = np.zeros((n_lat * PER_DEG, n_lon * PER_DEG), dtype=np.float32)
    jobs = [(la, lo) for la in range(TILE_LAT0, TILE_LAT1 + 1) for lo in range(TILE_LON0, TILE_LON1 + 1)]
    with ThreadPoolExecutor(8) as pool:
        tiles = list(pool.map(lambda j: fetch_tile(j[0], j[1], cache), jobs))
    for (la, lo), tile in zip(jobs, tiles):
        if tile is None:
            continue
        r0 = (TILE_LAT1 - la) * PER_DEG
        c0 = (lo - TILE_LON0) * PER_DEG
        mosaic[r0:r0 + PER_DEG, c0:c0 + PER_DEG] = tile
    return mosaic


def terrain_sampler(mosaic: np.ndarray):
    """terrain_m(lat, lon): bilinear height from the mosaic (cell centres at the tile's centres, as build_terrain.py writes them)."""
    def sample(lat, lon):
        lat = np.asarray(lat, dtype=np.float64)
        lon = np.asarray(lon, dtype=np.float64)
        rows = (TILE_LAT1 + 1 - lat) * PER_DEG - 0.5
        cols = (lon - TILE_LON0) * PER_DEG - 0.5
        return map_coordinates(mosaic, [rows.ravel(), cols.ravel()], order=1, mode="nearest").reshape(lat.shape)
    return sample


def bearing_and_distance(lat0: float, lon0: float, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Bearing (degrees clockwise from north) and great-circle distance (km) from a point to arrays of points."""
    p0 = math.radians(lat0)
    p1 = np.radians(lat)
    dl = np.radians(lon - lon0)
    a = np.sin((p1 - p0) / 2) ** 2 + math.cos(p0) * np.cos(p1) * np.sin(dl / 2) ** 2
    dist = 2 * R.EARTH_KM * np.arcsin(np.sqrt(a))
    brg = np.degrees(np.arctan2(np.sin(dl) * np.cos(p1), math.cos(p0) * np.sin(p1) - math.sin(p0) * np.cos(p1) * np.cos(dl)))
    return (brg + 360.0) % 360.0, dist


def bake(cache: str) -> tuple[np.ndarray, dict]:
    terrain = terrain_sampler(build_mosaic(cache))
    ny = round((NORTH - SOUTH) / STEP) + 1
    nx = round((EAST - WEST) / STEP) + 1
    lats = NORTH - np.arange(ny) * STEP
    lons = WEST + np.arange(nx) * STEP
    grid_lat, grid_lon = np.meshgrid(lats, lons, indexing="ij")
    best = np.zeros((ny, nx), dtype=np.uint8)
    azimuths = 720
    for sid, lat0, lon0, band, range_km in STATIONS:
        gates = int(min(range_km, R.MAX_RANGE_KM))
        rays = trace_rays_for(terrain, lat0, lon0, band, azimuths, gates)
        classes = R.classify(rays["agl_km"], rays["blocked"])             # (azimuths, gates)
        brg, dist = bearing_and_distance(lat0, lon0, grid_lat, grid_lon)
        inside = dist <= gates + 0.5
        a_idx = np.round(brg / (360.0 / azimuths)).astype(int) % azimuths
        g_idx = np.clip(np.round(dist).astype(int) - 1, 0, gates - 1)
        here = np.where(inside, classes[a_idx, g_idx], R.NONE)
        best = np.maximum(best, here)
        share = {c: int((here == c).sum()) for c in (R.POOR, R.LIMITED, R.GOOD)}
        print(f"  {sid}: {band}, {gates} km: poor {share[R.POOR]}, limited {share[R.LIMITED]}, good {share[R.GOOD]} cells")
    # one ridge top can blank a single ray; a place is not described by one ray, so lone thin streaks are smoothed away
    smooth = median_filter(best, size=5)
    smooth[best == R.NONE] = R.NONE
    best = smooth
    meta = {
        "version": 1,
        "south": SOUTH, "north": NORTH, "west": WEST, "east": EAST, "step": STEP, "nx": nx, "ny": ny,
        "classes": {"0": "no radar in range", "1": "low rain seen poorly", "2": "low rain seen partly", "3": "low rain seen well"},
        "assumptions": {
            "lowestSweepDeg": R.SWEEP_DEG, "beamWidthDeg": R.BEAM_DEG, "antennaM": R.ANTENNA_M, "effectiveEarthRadiusFactor": R.K_EFFECTIVE,
            "good": {"beamAboveGroundKm": R.GOOD_AGL_KM, "blocked": R.GOOD_BLOCK},
            "limited": {"beamAboveGroundKm": R.LIMITED_AGL_KM, "blocked": R.LIMITED_BLOCK},
            "terrain": "Copernicus GLO-30, 270 m",
        },
        "stations": [{"id": s[0], "lat": s[1], "lng": s[2], "band": s[3], "rangeKm": s[4]} for s in STATIONS],
    }
    return best, meta


def trace_rays_for(terrain, lat0: float, lon0: float, band: str, azimuths: int, gates: int) -> dict[str, np.ndarray]:
    return R.trace_rays(terrain, lat0, lon0, R.BEAM_DEG[band], azimuths=azimuths, gates=gates)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", default=os.path.join(tempfile.gettempdir(), "dem-l1"), help="where the terrain tiles are kept between runs")
    args = ap.parse_args()
    print("terrain tiles and rays...")
    classes, meta = bake(args.cache)
    os.makedirs(OUT_DIR, exist_ok=True)
    Image.fromarray(classes, mode="L").save(os.path.join(OUT_DIR, "radar-coverage.png"), optimize=True)
    with open(os.path.join(OUT_DIR, "radar-coverage.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
        f.write("\n")
    total = classes.size
    print({R_name: round(100 * float((classes == v).sum()) / total, 1) for R_name, v in (("none", 0), ("poor", 1), ("limited", 2), ("good", 3))}, "% of the box")


if __name__ == "__main__":
    main()
