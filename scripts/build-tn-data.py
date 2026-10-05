"""
Builds the static Tamil Nadu data files used by the microclimate layer:

  public/data/tn-elevation-500m.bin.gz   terrain raster (uint16 metres, 841 x 1121, gzip)
  public/data/tn-boundaries.geojson      state outline + 38 district polygons

Sources (downloaded once, cached in --cache):
  * Elevation: AWS "Terrain Tiles" (Terrarium encoding, z9), compiled from SRTM and other public
    DEMs. https://registry.opendata.aws/terrain-tiles/
  * Boundaries: geoBoundaries gbOpen India ADM1/ADM2 (simplified), ODbL 1.0,
    derived from lgdirectory.gov.in. https://www.geoboundaries.org/

The raster grid MUST match REGIONAL_* constants in src/app/core/domain/models/microclimate.model.ts:
columns are uniform in longitude and rows are uniform in Web-Mercator Y, so that MapLibre's
image-source (which stretches an image linearly in Mercator space) lines up exactly with the map.

Usage:  python scripts/build-tn-data.py [--cache DIR]
Needs:  numpy, Pillow
"""
import argparse
import gzip
import json
import math
import os
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

MIN_LAT, MAX_LAT, MIN_LON, MAX_LON = 8.0, 13.6, 76.2, 80.4
STEP = 0.005
WIDTH = round((MAX_LON - MIN_LON) / STEP) + 1   # 841
HEIGHT = round((MAX_LAT - MIN_LAT) / STEP) + 1  # 1121
Z = 9
N = 2 ** Z
TILE = 256
WORLD = N * TILE

TN_DISTRICTS = {
    'Ariyalur', 'Chengalputtu', 'Chennai', 'Coimbatore', 'Cuddalore', 'Dharmapuri', 'Dindigul', 'Erode',
    'Kallakurichi', 'Kancheepuram', 'Kanniyakumari', 'Karur', 'Krishnagiri', 'Madurai', 'Mayiladuthurai',
    'Nagapattinam', 'Namakkal', 'Perambalur', 'Pudukkottai', 'Ramanathapuram', 'Ranipet', 'Salem',
    'Sivaganga', 'Tenkasi', 'Thanjavur', 'The Nilgiris', 'Theni', 'Thiruvallur', 'Thiruvarur',
    'Thoothukkudi', 'Tiruchirappalli', 'Tirunelveli', 'Tirupathur', 'Tiruppur', 'Tiruvannamalai',
    'Vellore', 'Viluppuram', 'Virudhunagar',
}


def merc_y(lat):
    return math.asinh(math.tan(math.radians(lat)))


def world_x(lon):
    return (lon + 180.0) / 360.0 * WORLD


def world_y(lat_or_merc, is_merc=False):
    my = lat_or_merc if is_merc else merc_y(lat_or_merc)
    return (1.0 - my / math.pi) / 2.0 * WORLD


def fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 100:
        return path
    for _ in range(3):
        try:
            data = urllib.request.urlopen(url, timeout=120).read()
            with open(path, 'wb') as f:
                f.write(data)
            return path
        except Exception as e:  # retry
            err = e
    raise RuntimeError(f'download failed: {url}: {err}')


def build_elevation(cache, out_path):
    x0, x1 = int(world_x(MIN_LON) // TILE), int(world_x(MAX_LON) // TILE)
    y0, y1 = int(world_y(MAX_LAT) // TILE), int(world_y(MIN_LAT) // TILE)
    tiles = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]

    def get(t):
        x, y = t
        return fetch(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png',
                     os.path.join(cache, f'{Z}_{x}_{y}.png'))

    with ThreadPoolExecutor(6) as ex:
        paths = list(ex.map(get, tiles))

    mosaic = np.zeros(((y1 - y0 + 1) * TILE, (x1 - x0 + 1) * TILE), np.float32)
    for (x, y), p in zip(tiles, paths):
        rgb = np.array(Image.open(p).convert('RGB'), dtype=np.float32)
        elev = rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0
        mosaic[(y - y0) * TILE:(y - y0 + 1) * TILE, (x - x0) * TILE:(x - x0 + 1) * TILE] = elev
    mosaic = np.maximum(mosaic, 0.0)  # sea-level floor: bathymetry is irrelevant here

    # Area-average the mosaic into the target raster (box filter, sub-pixel exact)
    my_max, my_min = merc_y(MAX_LAT), merc_y(MIN_LAT)
    dmy = (my_max - my_min) / (HEIGHT - 1)
    bx0 = world_x(MIN_LON - STEP / 2) - x0 * TILE
    bx1 = world_x(MAX_LON + STEP / 2) - x0 * TILE
    by0 = world_y(my_max + dmy / 2, True) - y0 * TILE
    by1 = world_y(my_min - dmy / 2, True) - y0 * TILE
    img = Image.fromarray(mosaic, mode='F').resize((WIDTH, HEIGHT), Image.BOX, box=(bx0, by0, bx1, by1))
    grid = np.clip(np.rint(np.array(img)), 0, 65535).astype('<u2')

    raw = grid.tobytes()
    with open(out_path, 'wb') as f:
        f.write(gzip.compress(raw, 9))
    print(f'elevation: {WIDTH}x{HEIGHT}, max {grid.max()} m, '
          f'{len(raw) / 1e6:.2f} MB raw -> {os.path.getsize(out_path) / 1e3:.0f} KB gz')
    return grid


def simplify_ring(ring, tol=0.0004):
    """Douglas-Peucker on a closed ring (lon/lat degrees), rounded to 4 decimals (~11 m)."""
    pts = np.array(ring, dtype=np.float64)

    def rdp(p):
        if len(p) < 3:
            return p
        a, b = p[0], p[-1]
        ab = b - a
        norm = np.hypot(*ab)
        if norm == 0:
            d = np.hypot(*(p - a).T)
        else:
            d = np.abs(ab[0] * (p[:, 1] - a[1]) - ab[1] * (p[:, 0] - a[0])) / norm
        i = int(np.argmax(d))
        if d[i] > tol:
            left = rdp(p[:i + 1])
            right = rdp(p[i:])
            return np.vstack([left[:-1], right])
        return np.vstack([a, b])

    half = len(pts) // 2
    out = np.vstack([rdp(pts[:half + 1])[:-1], rdp(pts[half:])])
    out = np.round(out, 4)
    keep = [0] + [i for i in range(1, len(out)) if not np.array_equal(out[i], out[i - 1])]
    out = out[keep]
    if len(out) < 4:
        return None
    if not np.array_equal(out[0], out[-1]):
        out = np.vstack([out, out[0]])
    return out.tolist()


def simplify_geometry(geom):
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    result = []
    for poly in polys:
        rings = [simplify_ring(r) for r in poly]
        rings = [r for r in rings if r]
        if rings:
            result.append(rings)
    return {'type': 'MultiPolygon', 'coordinates': result}


def bbox_of(geom):
    xs, ys = [], []

    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0])
            ys.append(c[1])
        else:
            for k in c:
                walk(k)
    walk(geom['coordinates'])
    return min(xs), min(ys), max(xs), max(ys)


def build_boundaries(cache, out_path):
    base = 'https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/IND'
    a1 = json.load(open(fetch(f'{base}/ADM1/geoBoundaries-IND-ADM1_simplified.geojson',
                              os.path.join(cache, 'adm1.geojson')), encoding='utf-8'))
    a2 = json.load(open(fetch(f'{base}/ADM2/geoBoundaries-IND-ADM2_simplified.geojson',
                              os.path.join(cache, 'adm2.geojson')), encoding='utf-8'))

    state = next(f for f in a1['features'] if f['properties']['shapeName'].startswith('Tamil N'))
    features = [{'type': 'Feature', 'properties': {'kind': 'state', 'name': 'Tamil Nadu'},
                 'geometry': simplify_geometry(state['geometry'])}]
    sx0, sy0, sx1, sy1 = bbox_of(state['geometry'])
    found = set()
    for f in a2['features']:
        name = f['properties']['shapeName']
        if name not in TN_DISTRICTS:
            continue
        x0, y0, x1, y1 = bbox_of(f['geometry'])
        if x0 < sx0 - 0.1 or x1 > sx1 + 0.1 or y0 < sy0 - 0.1 or y1 > sy1 + 0.1:
            continue  # same name in another state
        found.add(name)
        features.append({'type': 'Feature', 'properties': {'kind': 'district', 'name': name},
                         'geometry': simplify_geometry(f['geometry'])})
    missing = TN_DISTRICTS - found
    if missing:
        raise RuntimeError(f'districts missing from source: {sorted(missing)}')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump({'type': 'FeatureCollection', 'features': features}, f, separators=(',', ':'))
    print(f'boundaries: state + {len(found)} districts, {os.path.getsize(out_path) / 1e3:.0f} KB')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join(tempfile.gettempdir(), 'tn-data-cache'))
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, 'public', 'data')
    os.makedirs(out_dir, exist_ok=True)
    build_elevation(args.cache, os.path.join(out_dir, 'tn-elevation-500m.bin.gz'))
    build_boundaries(args.cache, os.path.join(out_dir, 'tn-boundaries.geojson'))
