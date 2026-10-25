#!/usr/bin/env python3
"""
AtmosIQ All-India Radar Ingestion & Preprocessing Pipeline.

Fetches latest radar scans from all 45 IMD Doppler weather stations,
validates sweeps, removes background map artifacts (topography, sea,
district lines, range rings, canvas text), isolates precipitation echoes,
and outputs:
  - public/data/radar/india-composite.png (All-India georeferenced transparent composite)
  - public/data/radar/india-composite.gif (animated loop)
  - public/data/radar/stations/<station_id>.png (individual transparent radar sweeps)
  - public/data/radar/latest.json (metadata manifest with timestamps, status, bounds)

Runs on a schedule in GitHub Actions or manually via CLI.
"""

import argparse
import base64
import datetime
import hashlib
import io
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
from PIL import Image
from scipy import ndimage

# India Georeferenced Grid Bounds (WGS84)
GRID_BOUNDS = {
    'south': 6.0,
    'north': 37.5,
    'west': 67.0,
    'east': 98.0
}
# Grid Resolution: ~0.025 degrees per pixel -> 1240 x 1260 (~2.7 km/px)
GRID_RES = 0.025
GRID_W = int(round((GRID_BOUNDS['east'] - GRID_BOUNDS['west']) / GRID_RES))
GRID_H = int(round((GRID_BOUNDS['north'] - GRID_BOUNDS['south']) / GRID_RES))

# Agreed Windy-Style Radar Color Scale (dBZ to RGBA)
# val is normalized intensity: v = (dBZ - 12.0) / 9.6
RADAR_COLOR_STOPS = [
    (0.00,  36,  24, 158,   0),  # Transparent
    (0.30,  36,  24, 158, 140),  # ~12 dBZ
    (0.50,  14,  96, 154, 198),  # 14.6 dBZ
    (0.69,   4, 128, 136, 214),  # 18.6 dBZ
    (0.98,   2, 153, 144, 224),  # 21.4 dBZ
    (1.21,   3, 167, 133, 230),  # 23.6 dBZ
    (1.43,  20, 187, 131, 235),  # 25.7 dBZ
    (1.66,  62, 205, 125, 237),  # 27.9 dBZ
    (1.88,  75, 190,  86, 240),  # 30.0 dBZ
    (2.09, 125, 211,  76, 242),  # 32.1 dBZ
    (2.32, 175, 212,  44, 245),  # 34.3 dBZ
    (2.54, 210, 212,  27, 247),  # 36.4 dBZ
    (2.77, 235, 207,  22, 250),  # 38.6 dBZ
    (2.99, 227, 182,   5, 250),  # 40.7 dBZ
    (3.23, 242, 177,  21, 255),  # 43.0 dBZ
    (3.46, 241, 159,  33, 255),  # 45.2 dBZ
    (3.68, 233, 137,  51, 255),  # 47.3 dBZ
    (3.91, 210, 107,  49, 255),  # 49.5 dBZ
    (4.14, 205,  88,  70, 255),  # 51.7 dBZ
    (4.36, 199,  68,  82, 255),  # 53.9 dBZ
    (4.59, 185,  50,  93, 255),  # 56.1 dBZ
    (4.82, 168,  32,  98, 255),  # 58.3 dBZ
    (5.00, 145,  18, 105, 255),  # 60.0 dBZ
]

def dbz_to_v(dbz: float) -> float:
    return max(0.0, (dbz - 12.0) / 9.6)

def sample_radar_ramp(v: float):
    if v <= RADAR_COLOR_STOPS[0][0]:
        return (0, 0, 0, 0)
    last = RADAR_COLOR_STOPS[-1]
    if v >= last[0]:
        return (last[1], last[2], last[3], last[4])
    for i in range(len(RADAR_COLOR_STOPS) - 1):
        s0 = RADAR_COLOR_STOPS[i]
        s1 = RADAR_COLOR_STOPS[i + 1]
        if s0[0] <= v <= s1[0]:
            t = (v - s0[0]) / (s1[0] - s0[0] or 1.0)
            r = int(round(s0[1] + (s1[1] - s0[1]) * t))
            g = int(round(s0[2] + (s1[2] - s0[2]) * t))
            b = int(round(s0[3] + (s1[3] - s0[3]) * t))
            a = int(round(s0[4] + (s1[4] - s0[4]) * t))
            return (r, g, b, a)
    return (0, 0, 0, 0)

# Build 256-entry lookup table for fast quantization (0..255 byte map to RGBA)
INTENSITY_COLOR_LUT = np.zeros((256, 4), dtype=np.uint8)
for byte_val in range(256):
    intensity_v = (byte_val * 6.0) / 255.0
    INTENSITY_COLOR_LUT[byte_val] = sample_radar_ramp(intensity_v)

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

def fetch_url(url: str, timeout: int = 5) -> bytes | None:
    req = urllib.request.Request(
        url,
        headers={
            'User-Agent': UA,
            'Referer': 'https://mausam.imd.gov.in/'
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                data = resp.read()
                if len(data) > 1000 and not data.startswith(b'<!DOCTYPE') and not data.startswith(b'<html'):
                    return data
    except Exception:
        pass
    return None

def fetch_station_sweep(code: str, product: str = 'caz') -> tuple[bytes | None, str]:
    file_name = f"{product}_{code}.gif"

    # 1. Direct IMD
    url_direct = f"https://mausam.imd.gov.in/Radar/{file_name}"
    data = fetch_url(url_direct, timeout=4)
    if data and data[:3] == b'GIF':
        return data, 'direct'

    # 2. Netlify Proxy Fallback
    url_proxy = f"https://atmosradar.netlify.app/.netlify/functions/radar?file={file_name}"
    b64_data = fetch_url(url_proxy, timeout=5)
    if b64_data:
        try:
            decoded = base64.b64decode(b64_data)
            if decoded[:3] == b'GIF':
                return decoded, 'proxy'
        except Exception:
            pass

    return None, 'failed'

def looks_like_radar(arr: np.ndarray, palette: list | None) -> bool:
    """Verifies that the image contains the characteristic legend colors of a sweep, not a maintenance photo."""
    if not palette or len(palette) == 0:
        return True
    sample = arr[::3, ::3, :]
    flat_sample = sample.reshape(-1, 3)
    seen = 0
    for p in palette:
        pr, pg, pb = p[0], p[1], p[2]
        tol = max(9, int(p[4])) if len(p) > 4 else 12
        dist = np.sum(np.abs(flat_sample - np.array([pr, pg, pb])), axis=1)
        if np.any(dist <= tol * 2):
            seen += 1
    return seen >= max(2, int(len(palette) * 0.35))

def remove_background_cartography(arr: np.ndarray, is_x_band: bool = False) -> np.ndarray:
    """
    Identifies and returns a boolean mask where True indicates unwanted cartographic background:
    grayscale canvas, range rings, district/state boundary lines, cyan sea, tan terrain relief.
    """
    r = arr[..., 0].astype(np.int32)
    g = arr[..., 1].astype(np.int32)
    b = arr[..., 2].astype(np.int32)

    max_rgb = np.maximum(np.maximum(r, g), b)
    min_rgb = np.minimum(np.minimum(r, g), b)
    diff = max_rgb - min_rgb

    # 1. Black/Dark borders, grids, text (maxRGB <= 45)
    dark = max_rgb <= 45

    # 2. Pure grayscale / white paper canvas / monochromatic grid lines (diff <= 8)
    # Rejects pure white [255,255,255], range rings [243,243,242]
    grayscale = diff <= 8

    # 3. Administrative district boundaries & state borders in pure green (r <= 35 && g >= 160 && b <= 60)
    # Also catches broader green boundary lines (r <= 100, g >= 140, b <= 100)
    green_boundaries = ((r <= 35) & (g >= 160) & (b <= 60)) | ((r <= 100) & (g >= 140) & (b <= 100))

    # 4. Sea & Grayscale features (diff <= 25, e.g. grey sea background 191,191,191 and 134,134,134)
    sea_grayscale = diff <= 25

    # 5. Chennai Sea & Land Background:
    # Bay of Bengal sea in cyan/blue tones where b >= 140 and r >= 65
    # Authentic IMD blue/cyan rain echoes always have low red (r <= 50).
    cyan_sea = (b >= 140) & (r >= 65)

    # 6. Mountain terrain / elevation relief (Western Ghats warm tan/beige/khaki)
    # Topographic shading has warm tan/brown tints with high red/green and low-medium blue
    mountain_terrain = ((r >= 160) & (g >= 140) & (b >= 90) & (r >= b)) | \
                       ((r >= 120) & (g >= 80) & (b >= 40) & (r >= b + 25))

    return dark | grayscale | green_boundaries | sea_grayscale | cyan_sea | mountain_terrain

def keep_cores_in_rain(intensity: np.ndarray, candidates: np.ndarray) -> np.ndarray:
    """
    Context-sensitive swatches (white/cream/pale blue) that resemble map labels, relief, or sea
    are judged as connected patches: a patch is rain only when surrounded by sure rain echoes.
    Vectorized using scipy.ndimage.
    """
    if not np.any(candidates):
        return intensity

    sure_rain = (intensity > 0) & (~candidates)
    if not np.any(sure_rain):
        intensity[candidates] = 0.0
        return intensity

    rain_near = ndimage.binary_dilation(sure_rain, structure=np.ones((3, 3)))
    labeled, num_features = ndimage.label(candidates, structure=np.ones((3, 3)))
    if num_features == 0:
        return intensity

    dilated = ndimage.maximum_filter(labeled, size=3)
    border_labels = dilated[~candidates]
    border_is_rain = rain_near[~candidates]

    total_border = np.bincount(border_labels, minlength=num_features + 1)
    rain_border = np.bincount(border_labels[border_is_rain], minlength=num_features + 1)
    patch_sizes = np.bincount(labeled.ravel(), minlength=num_features + 1)

    share = rain_border[1:] / np.maximum(1, total_border[1:])
    needed_share = np.where(patch_sizes[1:] >= 1500, 0.75, 0.50)
    keep_labels = np.where(share >= needed_share)[0] + 1

    drop_mask = candidates & (~np.isin(labeled, keep_labels))
    intensity[drop_mask] = 0.0
    return intensity

def remove_map_drawings(intensity: np.ndarray) -> np.ndarray:
    """
    Removes boundary lines and coastlines drawn in legend colors (e.g. Visakhapatnam's red state lines,
    Sambalpur's cyan continental shelf) that are thin or not bordered by precipitation.
    Vectorized using scipy.ndimage.
    """
    strong_mask = intensity >= 1.5
    if not np.any(strong_mask):
        return intensity

    dist = ndimage.distance_transform_cdt(strong_mask, metric='chessboard')
    labeled, num_features = ndimage.label(strong_mask, structure=np.ones((3, 3)))
    if num_features == 0:
        return intensity

    max_depth = ndimage.maximum(dist, labels=labeled, index=np.arange(1, num_features + 1))
    patch_sizes = np.bincount(labeled.ravel(), minlength=num_features + 1)[1:]

    dilated = ndimage.maximum_filter(labeled, size=3)
    border_labels = dilated[~strong_mask]
    border_is_rain = (intensity > 0)[~strong_mask]

    total_border = np.bincount(border_labels, minlength=num_features + 1)[1:]
    rain_border = np.bincount(border_labels[border_is_rain], minlength=num_features + 1)[1:]

    share = rain_border / np.maximum(1, total_border)
    to_drop_labels = np.where((share < 0.15) & ((max_depth <= 2) | (patch_sizes >= 4)))[0] + 1

    drop_mask = np.isin(labeled, to_drop_labels)
    intensity[drop_mask] = 0.0
    return intensity

def fill_overlay_gaps(intensity: np.ndarray, max_gap: int = 4) -> np.ndarray:
    """Fills 1-2 pixel district lines or labels passing through dense rain with the mean of the surrounding rain."""
    zero_in_rain = (intensity == 0.0)
    has_rain = (intensity > 0.0)
    if not np.any(has_rain):
        return intensity

    kernel_size = 2 * max_gap + 1
    rain_count = ndimage.uniform_filter(has_rain.astype(np.float32), size=kernel_size) * (kernel_size * kernel_size)
    rain_sum = ndimage.uniform_filter(intensity, size=kernel_size) * (kernel_size * kernel_size)

    fill_mask = zero_in_rain & (rain_count >= 0.45 * (kernel_size * kernel_size))
    if np.any(fill_mask):
        intensity[fill_mask] = rain_sum[fill_mask] / np.maximum(1.0, rain_count[fill_mask])

    return intensity

def classify_station_sweep(img: Image.Image, crop: dict, palette: list | None, range_km: float, is_x_band: bool = False) -> tuple[np.ndarray, int, int]:
    """
    Crops the radar sweep, validates the format, isolates rain echoes, removes all background map layers,
    and returns a clean 2D intensity field (0.0 = no echo, > 0.0 = normalized intensity).
    """
    cx, cy, cw, ch = crop['x'], crop['y'], crop['w'], crop['h']
    cropped = img.crop((cx, cy, cx + cw, cy + ch)).convert('RGB')
    arr = np.asarray(cropped, dtype=np.int32)

    # 1. Circular dish scope mask
    radius = cw / 2.0
    Y, X = np.ogrid[:ch, :cw]
    dist_sq = (X - radius)**2 + (Y - radius)**2
    in_scope = dist_sq <= (radius * radius)

    intensity = np.zeros((ch, cw), dtype=np.float32)

    # Check for maintenance placeholder photo
    if not looks_like_radar(arr, palette):
        return intensity, cw, ch

    # 2. Identify background cartographic map features
    bg_mask = remove_background_cartography(arr, is_x_band)

    # 3. Classify rain pixels
    if palette and len(palette) > 0:
        pal_rgb = np.array([[p[0], p[1], p[2]] for p in palette], dtype=np.int32)
        pal_dbz = np.array([p[3] for p in palette], dtype=np.float32)
        pal_tol = np.array([p[4] if len(p) > 4 else 12.0 for p in palette], dtype=np.float32)
        pal_context = np.array([1 if len(p) > 5 and p[5] == 1 else 0 for p in palette], dtype=np.int32)

        flat_pixels = arr.reshape(-1, 3)
        flat_bg = bg_mask.reshape(-1)
        grid_flat = intensity.reshape(-1)
        context_cand_flat = np.zeros(ch * cw, dtype=bool)

        cand_indices = np.where(~flat_bg)[0]
        if len(cand_indices) > 0:
            cand_pixels = flat_pixels[cand_indices]
            chunk_size = 50000
            for start in range(0, len(cand_indices), chunk_size):
                end = min(start + chunk_size, len(cand_indices))
                batch_px = cand_pixels[start:end]
                batch_idx = cand_indices[start:end]

                diff = batch_px[:, np.newaxis, :] - pal_rgb[np.newaxis, :, :]
                dist = np.sqrt(np.sum(diff**2, axis=2))

                nearest_idx = np.argmin(dist, axis=1)
                nearest_dist = np.min(dist, axis=1)

                matched = (nearest_dist <= pal_tol[nearest_idx])
                matched_dbz = pal_dbz[nearest_idx]
                is_context = (pal_context[nearest_idx] == 1)

                valid_echo = matched & (matched_dbz >= 8.0)
                sub_matched_dbz = matched_dbz[valid_echo]
                v_vals = np.maximum(0.3, (sub_matched_dbz - 12.0) / 9.6)

                grid_flat[batch_idx[valid_echo]] = v_vals
                context_cand_flat[batch_idx[valid_echo & is_context]] = True

        intensity = grid_flat.reshape(ch, cw)
        context_candidates = context_cand_flat.reshape(ch, cw)

        # Remove known background cartography
        intensity[bg_mask] = 0.0
        context_candidates[bg_mask] = False

        # Keep cores only if inside genuine rain
        intensity = keep_cores_in_rain(intensity, context_candidates)

        # Remove district lines or coastlines painted in legend colors
        intensity = remove_map_drawings(intensity)

        # Fill gaps where district boundaries or text cuts through rain
        fill_overlay_gaps(intensity, max_gap=max(3, int(round(cw / 120))))
    else:
        # Fallback heuristic classification for uncalibrated stations
        r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
        rain_mask = in_scope & (~bg_mask) & (r + g + b > 50)

        purple = rain_mask & (r >= 180) & (b >= 140) & (g <= 100)
        intensity[purple] = 5.2

        red = rain_mask & (((r >= 180) & (g <= 80) & (b <= 80)) | ((r >= 150) & (g <= 50) & (b <= 50)))
        intensity[red] = 4.4

        orange = rain_mask & (r >= 210) & (b <= 50) & (g <= 180)
        intensity[orange] = 3.6

        yellow = rain_mask & (r >= 210) & (g >= 190) & (b <= 90)
        intensity[yellow] = 3.0

        green = rain_mask & (g >= 165) & (r <= 50) & (b <= 120)
        intensity[green] = 2.0

        cyan = rain_mask & (b >= 180) & (g >= 120) & (r <= 70)
        intensity[cyan] = 1.4

        blue = rain_mask & (b >= 150) & (r <= 50) & (g <= 120)
        intensity[blue] = 1.0

        dark_purple = rain_mask & (b >= 120) & (r <= 70) & (g <= 50)
        intensity[dark_purple] = 0.7

    # Strictly clip to radar dish circle
    intensity[~in_scope] = 0.0

    return intensity, cw, ch

def extract_gif_timestamp(data: bytes) -> str:
    """Attempts to extract the official observation ISO timestamp from binary GIF headers."""
    try:
        m = re.search(rb'(\d{4})[-_](\d{2})[-_](\d{2})[T_ ](\d{2}):?(\d{2})', data[:2048])
        if m:
            y, mo, d, h, mi = [int(x) for x in m.groups()]
            dt = datetime.datetime(y, mo, d, h, mi, tzinfo=datetime.timezone.utc)
            return dt.isoformat()
    except Exception:
        pass
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def main():
    parser = argparse.ArgumentParser(description="Atmos Radar All-India Preprocessing & Compositing Pipeline.")
    parser.add_argument("--out", default="public/data/radar", help="Output directory for preprocessed assets")
    parser.add_argument("--stations-config", default="", help="Path to radar_stations.json")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of stations (0 = all 45)")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    stations_dir = os.path.join(args.out, "stations")
    os.makedirs(stations_dir, exist_ok=True)

    config_path = args.stations_config or os.path.join(os.path.dirname(__file__), "data", "radar_stations.json")
    if not os.path.exists(config_path):
        print(f"Error: Radar configuration file {config_path} not found. Run scripts/export-radar-stations.js first.")
        sys.exit(1)

    with open(config_path, 'r', encoding='utf-8') as f:
        stations = json.load(f)

    if args.limit > 0:
        stations = stations[:args.limit]

    print(f">> Starting Preprocessed Radar Ingestion for {len(stations)} stations...", flush=True)
    start_time = time.time()

    # Master all-India georeferenced intensity grid (0.0..6.0 normalized intensity)
    india_grid = np.zeros((GRID_H, GRID_W), dtype=np.float32)
    active_stations = []
    station_reports = {}

    def process_station(st: dict):
        code = st['code']
        sid = st['id']
        name = st['name']
        band = st.get('band', 'S-Band')

        prod_key = None
        for p in ['caz', 'ppi', 'ppz', 'sri']:
            if p in st['products'] and not st['products'][p].get('unmeasured'):
                prod_key = p
                break

        if not prod_key:
            return {
                'id': sid, 'code': code, 'name': name, 'status': 'unmeasured',
                'error': 'No measured product layout'
            }

        prod = st['products'][prod_key]
        raw_data, method = fetch_station_sweep(code, prod_key)
        if not raw_data:
            return {
                'id': sid, 'code': code, 'name': name, 'status': 'offline',
                'error': f'Download failed for {prod_key}_{code}.gif'
            }

        try:
            gif = Image.open(io.BytesIO(raw_data))
            try:
                gif.seek(gif.n_frames - 1)
            except Exception:
                pass

            crop = prod['crop']
            w, h = gif.size
            if crop['x'] + crop['w'] > w + 2 or crop['y'] + crop['h'] > h + 2:
                crop = {'x': 0, 'y': 0, 'w': min(w, h), 'h': min(w, h)}

            intensity, cw, ch = classify_station_sweep(
                gif,
                crop,
                prod.get('palette'),
                prod['rangeKm'],
                is_x_band=(band == 'X-Band')
            )

            ts = extract_gif_timestamp(raw_data)
            has_rain = bool(np.any(intensity > 0.0))

            # Export individual station transparent PNG
            quantized_station = np.clip(intensity * (255.0 / 6.0), 0, 255).astype(np.uint8)
            rgba_station = INTENSITY_COLOR_LUT[quantized_station]
            img_station = Image.fromarray(rgba_station, mode='RGBA')
            station_png_path = os.path.join(stations_dir, f"{sid}.png")
            img_station.save(station_png_path, format="PNG", optimize=True)

            return {
                'id': sid,
                'name': name,
                'code': code,
                'lat': st['lat'],
                'lng': st['lng'],
                'rangeKm': prod['rangeKm'],
                'time': ts,
                'status': 'online',
                'method': method,
                'has_rain': has_rain,
                'intensity': intensity,
                'cw': cw,
                'ch': ch,
                'file': f"stations/{sid}.png"
            }
        except Exception as e:
            return {'id': sid, 'code': code, 'name': name, 'status': 'error', 'error': str(e)}

    # Fetch and process all stations concurrently with 16 threads
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(process_station, st): st for st in stations}
        for future in as_completed(futures):
            res = future.result()
            sid = res['id']
            station_reports[sid] = res
            if res['status'] == 'online':
                active_stations.append(res)
                rain_badge = " [RAIN ECHOES]" if res['has_rain'] else " [CLEAR]"
                print(f"  + [{res['code'].upper()}] {res['name']} ({res['time']}){rain_badge} via {res['method']}", flush=True)
            else:
                print(f"  - [{res['code'].upper()}] {res['name']}: {res.get('error', 'offline')}", flush=True)

    # Composite each active station onto master All-India georeferenced raster
    for st in active_stations:
        lat, lng, r_km = st['lat'], st['lng'], st['rangeKm']
        intensity, cw, ch = st['intensity'], st['cw'], st['ch']

        # Bounding box in degrees
        deg_lat = r_km / 111.0
        deg_lng = r_km / (111.0 * math.cos(math.radians(lat)))

        s_lat, n_lat = lat - deg_lat, lat + deg_lat
        w_lng, e_lng = lng - deg_lng, lng + deg_lng

        # Pixel coordinates on India Grid
        px0 = int(round((w_lng - GRID_BOUNDS['west']) / GRID_RES))
        px1 = int(round((e_lng - GRID_BOUNDS['west']) / GRID_RES))
        py0 = int(round((GRID_BOUNDS['north'] - n_lat) / GRID_RES))
        py1 = int(round((GRID_BOUNDS['north'] - s_lat) / GRID_RES))

        if px1 <= 0 or px0 >= GRID_W or py1 <= 0 or py0 >= GRID_H:
            continue

        target_w = max(1, px1 - px0)
        target_h = max(1, py1 - py0)

        im_st = Image.fromarray(intensity)
        im_resized = im_st.resize((target_w, target_h), Image.BILINEAR)
        st_arr = np.array(im_resized, dtype=np.float32)

        gx0, gx1 = max(0, px0), min(GRID_W, px1)
        gy0, gy1 = max(0, py0), min(GRID_H, py1)

        sx0, sx1 = gx0 - px0, target_w - (px1 - gx1)
        sy0, sy1 = gy0 - py0, target_h - (py1 - gy1)

        india_grid[gy0:gy1, gx0:gx1] = np.maximum(
            india_grid[gy0:gy1, gx0:gx1],
            st_arr[sy0:sy1, sx0:sx1]
        )

    # 1. Quantize intensity to 0..255 byte map
    quantized_composite = np.clip(india_grid * (255.0 / 6.0), 0, 255).astype(np.uint8)

    # 2. Colorize with agreed Windy-Style Radar Palette (Pure transparent background)
    rgba_output = INTENSITY_COLOR_LUT[quantized_composite]
    img_out = Image.fromarray(rgba_output, mode='RGBA')

    out_png = os.path.join(args.out, "india-composite.png")
    img_out.save(out_png, format="PNG", optimize=True)
    print(f"\n[SAVED] All-India Composite PNG: {out_png} ({os.path.getsize(out_png) / 1024:.1f} KB)", flush=True)

    # 3. Save Animated GIF loop
    out_gif = os.path.join(args.out, "india-composite.gif")
    img_out.save(out_gif, format="GIF", save_all=True, duration=400, loop=0)
    print(f"[SAVED] All-India Composite GIF: {out_gif}", flush=True)

    # 4. Write metadata manifest (latest.json)
    now_utc = datetime.datetime.now(datetime.timezone.utc).isoformat()
    manifest = {
        "generated_at": now_utc,
        "elapsed_sec": round(time.time() - start_time, 2),
        "bounds": GRID_BOUNDS,
        "maplibre_coordinates": [
            [GRID_BOUNDS['west'], GRID_BOUNDS['north']],  # NW
            [GRID_BOUNDS['east'], GRID_BOUNDS['north']],  # NE
            [GRID_BOUNDS['east'], GRID_BOUNDS['south']],  # SE
            [GRID_BOUNDS['west'], GRID_BOUNDS['south']],  # SW
        ],
        "resolution_deg": GRID_RES,
        "width": GRID_W,
        "height": GRID_H,
        "stations_total": len(stations),
        "stations_online": len(active_stations),
        "files": {
            "composite_png": "india-composite.png",
            "composite_gif": "india-composite.gif"
        },
        "stations": {
            st['id']: {
                "name": st['name'],
                "code": st['code'],
                "lat": st['lat'],
                "lng": st['lng'],
                "status": station_reports.get(st['id'], {}).get('status', 'offline'),
                "time": station_reports.get(st['id'], {}).get('time'),
                "rangeKm": station_reports.get(st['id'], {}).get('rangeKm', 250),
                "has_rain": station_reports.get(st['id'], {}).get('has_rain', False),
                "imageUrl": station_reports.get(st['id'], {}).get('file')
            } for st in stations
        }
    }

    out_json = os.path.join(args.out, "latest.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"[SAVED] Metadata Manifest: {out_json}", flush=True)

    # 5. Write status page (index.html) so root URL serves 200 OK
    out_html = os.path.join(args.out, "index.html")
    with open(out_html, "w", encoding="utf-8") as f:
        f.write(f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AtmosIQ Radar API</title>
  <style>
    body {{ font-family: system-ui, -apple-system, sans-serif; background: #0c1017; color: #e6edf3; padding: 2rem; max-width: 700px; margin: 0 auto; line-height: 1.6; }}
    h1 {{ color: #58a6ff; font-size: 1.5rem; margin-bottom: 0.5rem; }}
    .badge {{ display: inline-block; padding: 0.25rem 0.5rem; border-radius: 4px; background: #238636; color: #fff; font-size: 0.85rem; font-weight: 600; }}
    a {{ color: #58a6ff; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    ul {{ padding-left: 1.25rem; }}
    code {{ background: #161b22; padding: 0.2rem 0.4rem; border-radius: 4px; font-size: 0.9em; }}
  </style>
</head>
<body>
  <h1>AtmosIQ Preprocessed All-India Radar API</h1>
  <p><span class="badge">ONLINE</span> Active stations: {len(active_stations)} / {len(stations)}</p>
  <p>Last generated: <code>{now_utc}</code> ({manifest['elapsed_sec']}s)</p>
  <h3>Available Assets:</h3>
  <ul>
    <li><a href="latest.json"><code>latest.json</code></a> - Real-time metadata manifest</li>
    <li><a href="india-composite.png"><code>india-composite.png</code></a> - Single transparent RGBA radar composite</li>
    <li><a href="india-composite.gif"><code>india-composite.gif</code></a> - Radar composite loop</li>
  </ul>
</body>
</html>
""")
    print(f"[SAVED] Root Index HTML: {out_html}", flush=True)
    print(f"[DONE] Completed All-India radar preprocessing in {manifest['elapsed_sec']} seconds.", flush=True)

if __name__ == "__main__":
    main()
