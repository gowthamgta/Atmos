"""Builds self-hosted global 500 m WebP terrain tiles & model grids directly from Copernicus DEM GLO-30 (Page 3 ~240 m overview via COG HTTP Range).

Outputs into `--out` (default pipeline/data/terrain):
  tiles/{5,6,8}/{tx}/{ty}.webp  - Progressive self-hosted Web Mercator terrain (up to z=8 ~500 m, land tiles only)
  global.webp                   - 0.1 deg global DEM (1701 x 3600, -85..+85)
  global_model.webp             - 0.25 deg global model ground (681 x 1440, -85..+85)
  index.json                    - Metadata + compact base64 land-tile bitmasks (zero 404s over oceans)

Encoding (lossless RGBA WebP):
  Elevation (m) = (R * 256 + G) / 65535 * 9000.0  (12-bit quantized: 2.2 m vertical step)
  Land fraction = B / 255.0
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import io
import json
import math
import os
import re
import time

import numpy as np
from PIL import Image
import requests
import tifffile

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "data", "terrain")
COP_BUCKET = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com"
TILE_LIST_URL = f"{COP_BUCKET}/tileList.txt"

MAX_M = 9000.0
TILE_PX = 256
MIN_TILE_LAT = -56.0
MAX_TILE_LAT = 68.0
_NAME_RE = re.compile(r"Copernicus_DSM_COG_10_([NS])(\d{2})_00_([EW])(\d{3})_00_DEM")

_SESSION: requests.Session | None = None


def _session() -> requests.Session:
    global _SESSION
    if _SESSION is None:
        _SESSION = requests.Session()
        adapter = requests.adapters.HTTPAdapter(pool_connections=64, pool_maxsize=64)
        _SESSION.mount("https://", adapter)
    return _SESSION


def parse_cop_name(name: str) -> tuple[int, int] | None:
    m = _NAME_RE.match(name.strip())
    if not m:
        return None
    ns, lat_s, ew, lon_s = m.groups()
    lat = int(lat_s) if ns == "N" else -int(lat_s)
    lon = int(lon_s) if ew == "E" else -int(lon_s)
    return lat, lon


def fetch_tile_list() -> dict[tuple[int, int], str]:
    r = _session().get(TILE_LIST_URL, timeout=30)
    r.raise_for_status()
    out: dict[tuple[int, int], str] = {}
    for line in r.text.splitlines():
        name = line.strip()
        pos = parse_cop_name(name)
        if pos is not None:
            out[pos] = name
    return out


def fetch_cop_page3(name: str) -> np.ndarray | None:
    """Download only COG Page 3 (~240 m, 450x450) via two small HTTP Range requests."""
    url = f"{COP_BUCKET}/{name}/{name}.tif"
    sess = _session()
    for attempt in range(4):
        try:
            r = sess.get(url, headers={"Range": "bytes=0-16383"}, timeout=20)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            with tifffile.TiffFile(io.BytesIO(r.content)) as tif:
                p = tif.pages[min(3, len(tif.pages) - 1)]
                off, bc = p.dataoffsets[0], p.databytecounts[0]
                shape = p.shape
                r2 = sess.get(url, headers={"Range": f"bytes={off}-{off + bc - 1}"}, timeout=30)
                r2.raise_for_status()
                arr = p.decode(r2.content, 0)[0][0, :shape[0], :shape[1], 0]
            return np.nan_to_num(arr.astype(np.float32), nan=0.0)
        except Exception:
            if attempt == 3:
                return None
            time.sleep(0.5 * (attempt + 1))
    return None


def encode_webp(elev: np.ndarray, land: np.ndarray, path: str, quant_bits: int = 11) -> None:
    q = np.clip(np.round(np.clip(elev, 0.0, MAX_M) / MAX_M * 65535.0), 0, 65535).astype(np.uint32)
    if quant_bits < 16:
        shift = 16 - quant_bits
        q = (q >> shift) << shift
    rgba = np.zeros(elev.shape + (4,), dtype=np.uint8)
    rgba[..., 0] = (q >> 8).astype(np.uint8)
    rgba[..., 1] = (q & 0xFF).astype(np.uint8)
    # Quantize land fraction to 16 levels (4-bit * 17) so WebP compresses coastlines tightly while staying smooth
    rgba[..., 2] = (np.clip(np.round(np.clip(land, 0.0, 1.0) * 15.0), 0, 15) * 17).astype(np.uint8)
    rgba[..., 3] = 255
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(path, "WEBP", lossless=True, method=2)


def decode_webp(path: str) -> tuple[np.ndarray, np.ndarray]:
    rgba = np.asarray(Image.open(path).convert("RGBA"), dtype=np.uint32)
    elev = ((rgba[..., 0] * 256 + rgba[..., 1]) / 65535.0 * MAX_M).astype(np.float32)
    land = (rgba[..., 2] / 255.0).astype(np.float32)
    return elev, land


def merc_tile_bounds(z: int, tx: int, ty: int) -> tuple[float, float, float, float]:
    n = float(1 << z)
    west = tx / n * 360.0 - 180.0
    east = (tx + 1) / n * 360.0 - 180.0
    north = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * ty / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * (ty + 1) / n))))
    return west, south, east, north


def merc_tile_lat_lon(z: int, tx: int, ty: int) -> tuple[np.ndarray, np.ndarray]:
    n = float(1 << z)
    px = np.arange(TILE_PX, dtype=np.float64) + 0.5
    ux = (tx + px / TILE_PX) / n
    uy = (ty + px / TILE_PX) / n
    lon = ux * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1.0 - 2.0 * uy))))
    return lat[:, None], lon[None, :]


def sample_cop_tiles(
    lat_2d: np.ndarray,
    lon_2d: np.ndarray,
    tile_arrays: dict[tuple[int, int], np.ndarray],
) -> tuple[np.ndarray, np.ndarray]:
    """Bilinearly sample Copernicus 1x1 deg tiles onto target (lat, lon) grid."""
    h, w = lat_2d.shape[0], lon_2d.shape[1]
    elev = np.zeros((h, w), dtype=np.float32)
    land = np.zeros((h, w), dtype=np.float32)
    lats_1d = lat_2d[:, 0]
    lons_1d = lon_2d[0, :]
    lat_sws = np.floor(np.clip(lats_1d, -89.999, 89.999)).astype(int)
    lon_sws = np.floor(np.clip(lons_1d, -180.0, 179.999)).astype(int)

    for lat_sw in np.unique(lat_sws):
        r_mask = lat_sws == lat_sw
        rows = np.where(r_mask)[0]
        sub_lats = lats_1d[rows]
        for lon_sw in np.unique(lon_sws):
            arr = tile_arrays.get((int(lat_sw), int(lon_sw)))
            if arr is None:
                continue
            c_mask = lon_sws == lon_sw
            cols = np.where(c_mask)[0]
            sub_lons = lons_1d[cols]
            ny, nx = arr.shape
            ry = np.clip((lat_sw + 1.0 - sub_lats) * ny - 0.5, 0.0, ny - 1.0001)
            rx = np.clip((sub_lons - lon_sw) * nx - 0.5, 0.0, nx - 1.0001)
            y0 = np.floor(ry).astype(int)[:, None]
            x0 = np.floor(rx).astype(int)[None, :]
            fy = (ry - y0[:, 0])[:, None].astype(np.float32)
            fx = (rx - x0[0, :])[None, :].astype(np.float32)
            y1 = np.minimum(y0 + 1, ny - 1)
            x1 = np.minimum(x0 + 1, nx - 1)

            a00 = arr[y0, x0]
            a10 = arr[y0, x1]
            a01 = arr[y1, x0]
            a11 = arr[y1, x1]
            sub_e = (a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy
            sub_l = (
                ((a00 > 0.0).astype(np.float32) * (1 - fx) + (a10 > 0.0).astype(np.float32) * fx) * (1 - fy)
                + ((a01 > 0.0).astype(np.float32) * (1 - fx) + (a11 > 0.0).astype(np.float32) * fx) * fy
            )
            elev[np.ix_(rows, cols)] = np.clip(sub_e, 0.0, MAX_M)
            land[np.ix_(rows, cols)] = np.clip(sub_l, 0.0, 1.0)
    return elev, land


def pack_bitmask(z: int, coords: set[tuple[int, int]]) -> str:
    n = 1 << z
    bits = np.zeros((n, n), dtype=np.uint8)
    for tx, ty in coords:
        if 0 <= tx < n and 0 <= ty < n:
            bits[ty, tx] = 1
    packed = np.packbits(bits.ravel(), bitorder="big").tobytes()
    return base64.b64encode(packed).decode("ascii")


def lat_to_ty(lat: float, z: int) -> int:
    n = 1 << z
    lat_r = math.radians(max(-85.0511, min(85.0511, lat)))
    uy = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) * 0.5 * n
    return max(0, min(n - 1, int(math.floor(uy))))


def build(out_dir: str, workers: int = 24) -> None:
    os.makedirs(out_dir, exist_ok=True)
    print("Fetching Copernicus GLO-30 tile list...", flush=True)
    cop_map = fetch_tile_list()
    print(f"Found {len(cop_map)} Copernicus land tiles globally.", flush=True)

    # Global 0.1 deg (1701 x 3600) and 0.25 deg (681 x 1440) grids (-85..+85)
    g_fine_ny, g_fine_nx = 1701, 3600
    g_fine_lats = 85.0 - 0.1 * np.arange(g_fine_ny)
    g_fine_lons = -180.0 + 0.1 * np.arange(g_fine_nx)
    g_fine_elev = np.zeros((g_fine_ny, g_fine_nx), dtype=np.float32)
    g_fine_land = np.zeros((g_fine_ny, g_fine_nx), dtype=np.float32)

    g_mod_ny, g_mod_nx = 681, 1440
    g_mod_lats = 85.0 - 0.25 * np.arange(g_mod_ny)
    g_mod_lons = -180.0 + 0.25 * np.arange(g_mod_nx)
    g_mod_elev = np.zeros((g_mod_ny, g_mod_nx), dtype=np.float32)
    g_mod_land = np.zeros((g_mod_ny, g_mod_nx), dtype=np.float32)

    # Process from North (+85) to South (-85) in 1-degree latitude rows so every Copernicus tile is fetched once
    cop_cache: dict[tuple[int, int], np.ndarray] = {}
    ty_start = lat_to_ty(MAX_TILE_LAT, 8)
    ty_end = lat_to_ty(MIN_TILE_LAT, 8)
    z8_coords: set[tuple[int, int]] = set()

    def ensure_cop_band(lat_hi: int, lat_lo: int) -> None:
        needed = [
            (pos, cop_map[pos])
            for pos in cop_map
            if lat_lo <= pos[0] <= lat_hi and pos not in cop_cache
        ]
        if needed:
            with ThreadPoolExecutor(workers) as pool:
                results = list(pool.map(lambda item: (item[0], fetch_cop_page3(item[1])), needed))
            for pos, arr in results:
                if arr is not None:
                    cop_cache[pos] = arr
        # Evict tiles strictly north of lat_hi + 2
        for pos in [k for k in cop_cache if k[0] > lat_hi + 2]:
            del cop_cache[pos]

    # First pass over polar north (+85 down to MAX_TILE_LAT+1) for global.webp/global_model.webp
    for lat_sw in range(84, -86, -1):
        ensure_cop_band(lat_sw, lat_sw)
        # Fill intersecting rows of global.webp and global_model.webp
        f_rows = np.where((g_fine_lats >= lat_sw) & (g_fine_lats <= lat_sw + 1.0))[0]
        if len(f_rows):
            e, l = sample_cop_tiles(g_fine_lats[f_rows, None], g_fine_lons[None, :], cop_cache)
            g_fine_elev[f_rows, :] = np.maximum(g_fine_elev[f_rows, :], e)
            g_fine_land[f_rows, :] = np.maximum(g_fine_land[f_rows, :], l)
        m_rows = np.where((g_mod_lats >= lat_sw) & (g_mod_lats <= lat_sw + 1.0))[0]
        if len(m_rows):
            e, l = sample_cop_tiles(g_mod_lats[m_rows, None], g_mod_lons[None, :], cop_cache)
            g_mod_elev[m_rows, :] = np.maximum(g_mod_elev[m_rows, :], e)
            g_mod_land[m_rows, :] = np.maximum(g_mod_land[m_rows, :], l)

        # Build z=8 tiles whose northern edge falls inside or has reached (lat_sw, lat_sw+1)
        for ty in range(ty_start, ty_end + 1):
            _, s_t, _, n_t = merc_tile_bounds(8, 0, ty)
            if math.floor(s_t) == lat_sw:
                # All Copernicus tiles needed for row `ty` are between floor(s_t) and floor(n_t)
                ensure_cop_band(math.floor(n_t), math.floor(s_t))
                for tx in range(256):
                    w_t, _, e_t, _ = merc_tile_bounds(8, tx, ty)
                    has_any = any(
                        (la, lo) in cop_cache
                        for la in range(math.floor(s_t), math.floor(n_t) + 1)
                        for lo in range(math.floor(w_t), math.floor(e_t) + 1)
                    )
                    if not has_any:
                        continue
                    t_lat, t_lon = merc_tile_lat_lon(8, tx, ty)
                    te, tl = sample_cop_tiles(t_lat, t_lon, cop_cache)
                    if not np.any(tl > 0.01):
                        continue
                    encode_webp(te, tl, os.path.join(out_dir, "tiles", "8", str(tx), f"{ty}.webp"), quant_bits=11)
                    z8_coords.add((tx, ty))
        if lat_sw % 10 == 0:
            print(f"  lat={lat_sw:+d} deg processed | z8 land tiles={len(z8_coords)}", flush=True)

    fine_path = os.path.join(out_dir, "global.webp")
    model_path = os.path.join(out_dir, "global_model.webp")
    encode_webp(g_fine_elev, g_fine_land, fine_path, quant_bits=16)
    encode_webp(g_mod_elev, g_mod_land, model_path, quant_bits=16)
    print(f"Saved global.webp ({os.path.getsize(fine_path)//1024} KB) and global_model.webp ({os.path.getsize(model_path)//1024} KB).", flush=True)

    # Downsample z=8 -> z=6 (4x4) and z=6 -> z=5 (2x2)
    z6_candidates = {(tx // 4, ty // 4) for tx, ty in z8_coords}
    z6_coords: set[tuple[int, int]] = set()
    for tx6, ty6 in sorted(z6_candidates):
        block_e = np.zeros((1024, 1024), dtype=np.float32)
        block_l = np.zeros((1024, 1024), dtype=np.float32)
        for dy in range(4):
            for dx in range(4):
                c8 = (tx6 * 4 + dx, ty6 * 4 + dy)
                if c8 in z8_coords:
                    e8, l8 = decode_webp(os.path.join(out_dir, "tiles", "8", str(c8[0]), f"{c8[1]}.webp"))
                    block_e[dy * 256:(dy + 1) * 256, dx * 256:(dx + 1) * 256] = e8
                    block_l[dy * 256:(dy + 1) * 256, dx * 256:(dx + 1) * 256] = l8
        e6 = block_e.reshape(256, 4, 256, 4).mean(axis=(1, 3))
        l6 = block_l.reshape(256, 4, 256, 4).mean(axis=(1, 3))
        if np.any(l6 > 0.005):
            encode_webp(e6, l6, os.path.join(out_dir, "tiles", "6", str(tx6), f"{ty6}.webp"), quant_bits=11)
            z6_coords.add((tx6, ty6))

    z5_candidates = {(tx // 2, ty // 2) for tx, ty in z6_coords}
    z5_coords: set[tuple[int, int]] = set()
    for tx5, ty5 in sorted(z5_candidates):
        block_e = np.zeros((512, 512), dtype=np.float32)
        block_l = np.zeros((512, 512), dtype=np.float32)
        for dy in range(2):
            for dx in range(2):
                c6 = (tx5 * 2 + dx, ty5 * 2 + dy)
                if c6 in z6_coords:
                    e6, l6 = decode_webp(os.path.join(out_dir, "tiles", "6", str(c6[0]), f"{c6[1]}.webp"))
                    block_e[dy * 256:(dy + 1) * 256, dx * 256:(dx + 1) * 256] = e6
                    block_l[dy * 256:(dy + 1) * 256, dx * 256:(dx + 1) * 256] = l6
        e5 = block_e.reshape(256, 2, 256, 2).mean(axis=(1, 3))
        l5 = block_l.reshape(256, 2, 256, 2).mean(axis=(1, 3))
        if np.any(l5 > 0.005):
            encode_webp(e5, l5, os.path.join(out_dir, "tiles", "5", str(tx5), f"{ty5}.webp"), quant_bits=11)
            z5_coords.add((tx5, ty5))

    print(f"Built self-hosted terrain tiles: z5={len(z5_coords)}, z6={len(z6_coords)}, z8={len(z8_coords)}", flush=True)

    idx_path = os.path.join(DEFAULT_OUT, "index.json")
    idx = {}
    if os.path.exists(idx_path):
        with open(idx_path, "r", encoding="utf-8") as f:
            idx = json.load(f)
    idx["global"] = {
        "min": 0,
        "max": int(MAX_M),
        "selfHosted": True,
        "maxZ": 8,
        "tileLevels": [5, 6, 8],
        "tileBits": {
            "5": pack_bitmask(5, z5_coords),
            "6": pack_bitmask(6, z6_coords),
            "8": pack_bitmask(8, z8_coords),
        },
        "fine": {
            "file": "global.webp",
            "latMax": 85.0, "latMin": -85.0, "lonMin": -180.0, "lonMax": 179.9,
            "step": 0.1, "nx": g_fine_nx, "ny": g_fine_ny,
        },
        "model": {
            "file": "global_model.webp",
            "latMax": 85.0, "latMin": -85.0, "lonMin": -180.0, "lonMax": 179.75,
            "step": 0.25, "nx": g_mod_nx, "ny": g_mod_ny,
        },
    }
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(idx, f, indent=2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--workers", type=int, default=24)
    args = ap.parse_args()
    build(args.out, workers=args.workers)


if __name__ == "__main__":
    main()
