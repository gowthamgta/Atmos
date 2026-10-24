#!/usr/bin/env python3
"""
AtmosIQ All-India Radar Ingestion & Compositing Pipeline.

Fetches latest radar scans from all 45 IMD Doppler weather stations,
decodes their reflectivity (dBZ) from calibrated palettes, removes printed map artifacts,
stitches them into a single georeferenced All-India composite (PNG and animated GIF),
and writes public/data/radar/latest.json for direct consumption by the web app.
"""

import argparse
import base64
import datetime
import io
import json
import math
import os
import re
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
import numpy as np
from PIL import Image

# India Georeferenced Grid Bounds
GRID_BOUNDS = {
    'south': 6.0,
    'north': 37.5,
    'west': 67.0,
    'east': 98.0
}
# Grid Resolution: ~0.025 degrees per pixel -> 1240 x 1260
GRID_RES = 0.025
GRID_W = int((GRID_BOUNDS['east'] - GRID_BOUNDS['west']) / GRID_RES)
GRID_H = int((GRID_BOUNDS['north'] - GRID_BOUNDS['south']) / GRID_RES)

# Agreed Windy-Style Radar Color Scale (dBZ to RGBA)
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

def dbz_to_v(dbz):
    return (dbz - 12.0) / 9.6

def sample_radar_ramp(v):
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

# Build fast 256-entry lookup table for intensity byte (0..255)
INTENSITY_COLOR_LUT = np.zeros((256, 4), dtype=np.uint8)
for byte_val in range(256):
    v = (byte_val * 6.0) / 255.0
    INTENSITY_COLOR_LUT[byte_val] = sample_radar_ramp(v)

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

def fetch_url(url, timeout=15):
    import urllib.request
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': 'https://mausam.imd.gov.in/'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                data = resp.read()
                if len(data) > 1000 and not data.startswith(b'<!DOCTYPE') and not data.startswith(b'<html'):
                    return data
    except Exception:
        pass
    return None

def fetch_station_sweep(code, product='caz'):
    file_name = f"{product}_{code}.gif"
    # 1. Direct IMD
    url_direct = f"https://mausam.imd.gov.in/Radar/{file_name}"
    data = fetch_url(url_direct)
    if data:
        return data, 'direct'
    
    # 2. Netlify Proxy Fallback
    url_proxy = f"https://atmosradar.netlify.app/.netlify/functions/radar?file={file_name}"
    b64_data = fetch_url(url_proxy)
    if b64_data:
        try:
            return base64.b64decode(b64_data), 'proxy'
        except Exception:
            pass
            
    return None, 'failed'

def classify_station_pixels(img, crop, palette, range_km):
    """Crops the radar circle, matches palette colors to dBZ, returns 2D intensity grid."""
    w, h = img.size
    cx, cy, cw, ch = crop['x'], crop['y'], crop['w'], crop['h']
    
    # Crop to station radar viewport
    cropped = img.crop((cx, cy, cx + cw, cy + ch)).convert('RGB')
    arr = np.asarray(cropped, dtype=np.int32)
    
    # Radar scope mask (circle with radius cw / 2)
    radius = cw / 2.0
    Y, X = np.ogrid[:ch, :cw]
    dist_sq = (X - radius)**2 + (Y - radius)**2
    in_scope = dist_sq <= (radius * radius)
    
    # Match colors to palette
    intensity = np.zeros((ch, cw), dtype=np.float32)
    
    if palette == 'chennai' or not isinstance(palette, list) or len(palette) == 0:
        # Default Selex-style thresholding for Chenna / standard
        # Standard rain colors have high R+G or R relative to B
        r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
        # Ignore dark background / borders
        valid = in_scope & (r + g + b > 50)
        # Approximate dBZ mapping
        dbz = np.clip(10.0 + (r * 0.4 + g * 0.2 - b * 0.1), 0.0, 65.0)
        intensity[valid] = dbz_to_v(dbz[valid])
    else:
        # Custom calibrated palette lookup
        pal_rgb = np.array([[p[0], p[1], p[2]] for p in palette], dtype=np.int32)
        pal_dbz = np.array([p[3] for p in palette], dtype=np.float32)
        pal_tol = np.array([p[4] if len(p) > 4 else 12.0 for p in palette], dtype=np.float32)
        pal_is_map = np.array([1 if len(p) > 5 and p[5] == 1 else 0 for p in palette], dtype=np.int32)

        # Vectorized color distance matching
        pixels = arr.reshape(-1, 3)
        diff = pixels[:, np.newaxis, :] - pal_rgb[np.newaxis, :, :]
        dist = np.sqrt(np.sum(diff**2, axis=2))
        
        nearest_idx = np.argmin(dist, axis=1)
        nearest_dist = np.min(dist, axis=1)
        
        valid_match = (nearest_dist <= pal_tol[nearest_idx]) & (pal_is_map[nearest_idx] == 0)
        matched_dbz = pal_dbz[nearest_idx]
        
        grid_flat = intensity.reshape(-1)
        grid_flat[valid_match] = dbz_to_v(matched_dbz[valid_match])
        intensity = grid_flat.reshape(ch, cw)
        intensity[~in_scope] = 0.0

    return intensity, cw, ch

def extract_gif_timestamp(data):
    """Tries to extract timestamp from GIF bytes or default to current UTC."""
    try:
        # Search for ISO or YYYYMMDD_HHMM format in byte string
        m = re.search(rb'(\d{4})[-_](\d{2})[-_](\d{2})[T_ ](\d{2}):?(\d{2})', data[:2048])
        if m:
            y, mo, d, h, mi = [int(x) for x in m.groups()]
            dt = datetime.datetime(y, mo, d, h, mi, tzinfo=datetime.timezone.utc)
            return dt.isoformat()
    except Exception:
        pass
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def main():
    parser = argparse.ArgumentParser(description="Fetch and composite All-India IMD Doppler Weather Radars.")
    parser.add_argument("--out", default="public/data/radar", help="Output directory")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of stations (0 = all)")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    stations_file = os.path.join(os.path.dirname(__file__), "data", "radar_stations.json")
    if not os.path.exists(stations_file):
        print(f"Error: {stations_file} not found. Run scripts/export-radar-stations.js first.")
        sys.exit(1)

    with open(stations_file, 'r', encoding='utf-8') as f:
        stations = json.load(f)

    if args.limit > 0:
        stations = stations[:args.limit]

    print(f">> Starting All-India Radar Ingestion for {len(stations)} stations...")
    start_time = time.time()

    # Master all-India intensity raster: 0..6 (Float32)
    india_grid = np.zeros((GRID_H, GRID_W), dtype=np.float32)
    active_stations = []

    def process_station(st):
        code = st['code']
        sid = st['id']
        prod_key = 'caz' if 'caz' in st['products'] else 'ppi'
        prod = st['products'].get(prod_key)
        if not prod or 'unmeasured' in prod:
            return None

        data, method = fetch_station_sweep(code, prod_key)
        if not data:
            return {'id': sid, 'code': code, 'status': 'offline', 'error': 'No response'}

        try:
            gif = Image.open(io.BytesIO(data))
            # Seek to last frame if animated
            try:
                gif.seek(gif.n_frames - 1)
            except Exception:
                pass

            intensity, cw, ch = classify_station_pixels(gif, prod['crop'], prod.get('palette'), prod['rangeKm'])
            ts = extract_gif_timestamp(data)
            return {
                'id': sid,
                'name': st['name'],
                'code': code,
                'lat': st['lat'],
                'lng': st['lng'],
                'rangeKm': prod['rangeKm'],
                'time': ts,
                'status': 'online',
                'method': method,
                'intensity': intensity,
                'cw': cw,
                'ch': ch
            }
        except Exception as e:
            return {'id': sid, 'code': code, 'status': 'error', 'error': str(e)}

    # Fetch in parallel with 16 threads
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(process_station, st): st for st in stations}
        for future in as_completed(futures):
            res = future.result()
            if not res:
                continue
            if res['status'] == 'online':
                active_stations.append(res)
                print(f"  + [{res['code'].upper()}] {res['name']} ({res['time']}) via {res['method']}")
            else:
                print(f"  - [{res['code'].upper()}] {res.get('error', 'offline')}")

    # Composite each active station onto the All-India grid
    for st in active_stations:
        lat, lng, r_km = st['lat'], st['lng'], st['rangeKm']
        intensity, cw, ch = st['intensity'], st['cw'], st['ch']
        
        # Calculate bounding box in degrees
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
        
        # Resize station intensity to target grid slice
        im_st = Image.fromarray(intensity)
        im_resized = im_st.resize((target_w, target_h), Image.BILINEAR)
        st_arr = np.array(im_resized, dtype=np.float32)
        
        # Clip to grid bounds
        gx0, gx1 = max(0, px0), min(GRID_W, px1)
        gy0, gy1 = max(0, py0), min(GRID_H, py1)
        
        sx0, sx1 = gx0 - px0, target_w - (px1 - gx1)
        sy0, sy1 = gy0 - py0, target_h - (py1 - gy1)
        
        # Where overlapping, take maximum dBZ (strongest echo)
        india_grid[gy0:gy1, gx0:gx1] = np.maximum(india_grid[gy0:gy1, gx0:gx1], st_arr[sy0:sy1, sx0:sx1])

    # 1. Quantize intensity to 0..255 byte map
    quantized = np.clip(india_grid * (255.0 / 6.0), 0, 255).astype(np.uint8)
    
    # 2. Colorize with agreed Windy-Style Radar Palette
    rgba_output = INTENSITY_COLOR_LUT[quantized]
    img_out = Image.fromarray(rgba_output, mode='RGBA')
    
    out_png = os.path.join(args.out, "india-composite.png")
    img_out.save(out_png, format="PNG", optimize=True)
    print(f"[SAVED] All-India Composite PNG: {out_png} ({os.path.getsize(out_png) / 1024:.1f} KB)")

    # 3. Save Animated GIF loop
    out_gif = os.path.join(args.out, "india-composite.gif")
    img_out.save(out_gif, format="GIF", save_all=True, duration=400, loop=0)
    print(f"[SAVED] All-India Composite GIF: {out_gif}")

    # 4. Write metadata manifest (latest.json)
    manifest = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "elapsed_sec": round(time.time() - start_time, 2),
        "bounds": GRID_BOUNDS,
        "resolution_deg": GRID_RES,
        "width": GRID_W,
        "height": GRID_H,
        "stations_total": len(stations),
        "stations_online": len(active_stations),
        "files": {
            "composite_png": "india-composite.png",
            "composite_gif": "india-composite.gif"
        },
        "stations": [
            {
                "id": s['id'],
                "code": s['code'],
                "name": s['name'],
                "lat": s['lat'],
                "lng": s['lng'],
                "time": s['time'],
                "rangeKm": s['rangeKm']
            } for s in active_stations
        ]
    }
    
    out_json = os.path.join(args.out, "latest.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"[SAVED] Radar Manifest: {out_json}")
    print(f"[DONE] Completed in {manifest['elapsed_sec']} seconds.")

if __name__ == "__main__":
    main()
