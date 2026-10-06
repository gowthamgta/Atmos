"""
Builds the static South India data files used by the forecast layer:

  public/data/sa-elevation-1km.png        terrain on a 0.01 deg (~1.1 km) grid: metres 0..4000 in R,G; land fraction in B
  public/data/sa-elevation-smooth.png     the terrain smoothed over ~4 km, on a 0.05 deg grid (R,G metres, B unused)
  public/data/sa-model-elevation-<K>km.png  the ground as a K km model sees it (box mean over K km), on the 0.1 deg
                                          forecast grid: metres in R,G, land fraction in B. One file per model resolution.
  public/data/sa-terrain.json             grid geometry, value ranges and the list of model resolutions
  public/data/south-india-districts.geojson   state outlines and district polygons (no label points: the map shows no place names)

Why these grids: every model is published on the 0.1 deg grid, but a model sees its own (coarser) cells as flat
ground at their mean height. The shader corrects the near-surface fields per 1 km pixel by the difference between
the real ground and the model's ground (temperature, dew point, humidity, moisture column), uses the smoothed
terrain for ridge exposure and windward lift (wind, rain, low cloud), and the land fraction for the sea-land wind
contrast at the coast. The models' own orography is not published, so it is approximated by box-averaging the DEM
over each model's native cell size.

Terrain PNG encoding (not the forecast rg16 format: B is data here, never a "no data" flag):
  metres = (R * 256 + G) / 65535 * 4000,  land fraction = B / 255

Sources (downloaded once, cached in --cache):
  * Elevation: AWS "Terrain Tiles" (Terrarium encoding, z8 ~ 0.6 km/pixel), compiled from SRTM and other
    public DEMs, with bathymetry (used only to tell sea from land). https://registry.opendata.aws/terrain-tiles/
  * Boundaries: geoBoundaries gbOpen India ADM1/ADM2 (simplified), ODbL 1.0, derived from lgdirectory.gov.in.
    This release predates the 2022 Andhra Pradesh re-organisation (14 districts instead of 26) and has 30
    Karnataka districts. https://www.geoboundaries.org/

Usage:  python scripts/build-south-india-data.py [--cache DIR]
Needs:  numpy, Pillow, shapely
"""
import argparse
import io
import json
import math
import os
import sys
import tempfile
import unicodedata
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Must match pipeline/config.py (forecast grid) so the model-elevation PNG lines up with the forecast PNGs.
LAT_MAX, LAT_MIN, LON_MIN, LON_MAX = 22.0, 4.0, 68.0, 90.0
FINE_STEP = 0.01
MODEL_STEP = 0.1
FINE_W = round((LON_MAX - LON_MIN) / FINE_STEP) + 1   # 2201
FINE_H = round((LAT_MAX - LAT_MIN) / FINE_STEP) + 1   # 1801
MODEL_W = round((LON_MAX - LON_MIN) / MODEL_STEP) + 1  # 221
MODEL_H = round((LAT_MAX - LAT_MIN) / MODEL_STEP) + 1  # 181
ELEV_MAX = 4000.0

Z = 8
TILE = 256
WORLD = (2 ** Z) * TILE

STATES = {
    'Tamil Nadu': 'Tamil Nadu', 'Kerala': 'Kerala', 'Karnataka': 'Karnataka',
    'Andhra Pradesh': 'Andhra Pradesh', 'Telangana': 'Telangana', 'Puducherry': 'Puducherry',
    'Lakshadweep': 'Lakshadweep',
}


def ascii_name(s):
    return ''.join(c for c in unicodedata.normalize('NFKD', s) if not unicodedata.combining(c))


def world_x(lon):
    return (np.asarray(lon) + 180.0) / 360.0 * WORLD


def world_y(lat):
    lat = np.radians(np.asarray(lat))
    return (1.0 - np.arcsinh(np.tan(lat)) / math.pi) / 2.0 * WORLD


def fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 100:
        return path
    err = None
    for _ in range(3):
        try:
            data = urllib.request.urlopen(url, timeout=120).read()
            with open(path, 'wb') as f:
                f.write(data)
            return path
        except Exception as e:  # retry
            err = e
    raise RuntimeError(f'download failed: {url}: {err}')


# Native grid spacing (km) of the models the app shows; one model-ground file is written per value.
MODEL_KMS = (9, 10, 13, 15, 28, 55)
SMOOTH_STEP = 0.05
SMOOTH_SIGMA_KM = 4.0
KM_PER_DEG = 111.2


def encode_terrain(metres, land=None):
    """RGB PNG: metres 0..ELEV_MAX in R,G (16 bits), land fraction 0..1 in B."""
    q = np.rint(np.clip(metres, 0, ELEV_MAX) / ELEV_MAX * 65535).astype(np.uint32)
    rgb = np.zeros(metres.shape + (3,), np.uint8)
    rgb[..., 0] = q >> 8
    rgb[..., 1] = q & 255
    if land is not None:
        rgb[..., 2] = np.rint(np.clip(land, 0, 1) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgb, 'RGB').save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def box_mean(field, half):
    """Mean over a (2*half+1)^2 window around every cell, edges clamped (integral image)."""
    padded = np.pad(field, half, mode='edge').astype(np.float64)
    integral = np.zeros((padded.shape[0] + 1, padded.shape[1] + 1), np.float64)
    integral[1:, 1:] = padded.cumsum(0).cumsum(1)
    n = 2 * half + 1
    h, w = field.shape
    total = integral[n:n + h, n:n + w] - integral[:h, n:n + w] - integral[n:n + h, :w] + integral[:h, :w]
    return (total / (n * n)).astype(np.float32)


def gaussian_blur(field, sigma):
    """Separable Gaussian blur (sigma in cells), edges clamped."""
    r = int(math.ceil(sigma * 3))
    k = np.exp(-(np.arange(-r, r + 1) ** 2) / (2 * sigma * sigma))
    k /= k.sum()
    out = np.pad(field, ((r, r), (0, 0)), mode='edge')
    out = sum(k[i] * out[i:i + field.shape[0]] for i in range(2 * r + 1))
    out = np.pad(out, ((0, 0), (r, r)), mode='edge')
    out = sum(k[i] * out[:, i:i + field.shape[1]] for i in range(2 * r + 1))
    return out.astype(np.float32)


def build_elevation(cache, out_dir):
    x0, x1 = int(world_x(LON_MIN) // TILE), int(world_x(LON_MAX) // TILE)
    y0, y1 = int(world_y(LAT_MAX) // TILE), int(world_y(LAT_MIN) // TILE)
    tiles = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    print(f'elevation: {len(tiles)} terrain tiles at z{Z}')

    def get(t):
        x, y = t
        return fetch(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png',
                     os.path.join(cache, f'{Z}_{x}_{y}.png'))

    with ThreadPoolExecutor(6) as ex:
        paths = list(ex.map(get, tiles))

    raw = np.zeros(((y1 - y0 + 1) * TILE, (x1 - x0 + 1) * TILE), np.float32)
    for (x, y), p in zip(tiles, paths):
        rgb = np.array(Image.open(p).convert('RGB'), dtype=np.float32)
        elev = rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0
        raw[(y - y0) * TILE:(y - y0 + 1) * TILE, (x - x0) * TILE:(x - x0 + 1) * TILE] = elev
    mosaic = np.clip(raw, 0.0, ELEV_MAX - 1)  # sea-level floor for heights
    is_land = (raw > 0.0).astype(np.float32)  # bathymetry says where the sea is

    # Box-average the mosaic into cells centred on the target grid points, using an integral image.
    lon_edges = LON_MIN + (np.arange(FINE_W + 1) - 0.5) * FINE_STEP
    lat_edges = LAT_MAX - (np.arange(FINE_H + 1) - 0.5) * FINE_STEP
    xe = np.clip(np.rint(world_x(lon_edges) - x0 * TILE).astype(int), 0, raw.shape[1])
    ye = np.clip(np.rint(world_y(lat_edges) - y0 * TILE).astype(int), 0, raw.shape[0])
    xe[1:] = np.maximum(xe[1:], xe[:-1] + 1).clip(max=raw.shape[1])
    ye[1:] = np.maximum(ye[1:], ye[:-1] + 1).clip(max=raw.shape[0])
    area = np.outer(np.diff(ye), np.diff(xe)).astype(np.float64)

    def cell_mean(src):
        integral = np.zeros((src.shape[0] + 1, src.shape[1] + 1), np.float64)
        integral[1:, 1:] = src.cumsum(0).cumsum(1)
        total = (integral[np.ix_(ye[1:], xe[1:])] - integral[np.ix_(ye[:-1], xe[1:])]
                 - integral[np.ix_(ye[1:], xe[:-1])] + integral[np.ix_(ye[:-1], xe[:-1])])
        return (total / area).astype(np.float32)

    fine = cell_mean(mosaic)
    land = cell_mean(is_land)
    assert fine.shape == (FINE_H, FINE_W), fine.shape
    files = {'sa-elevation-1km.png': encode_terrain(fine, land)}

    # ~4 km smoothed terrain on a 0.05 deg grid: the reference for ridge/valley exposure and for windward slopes
    r = round(SMOOTH_STEP / FINE_STEP)
    smooth = gaussian_blur(fine, SMOOTH_SIGMA_KM / (FINE_STEP * KM_PER_DEG))[::r, ::r]
    files['sa-elevation-smooth.png'] = encode_terrain(smooth)

    # The ground each model sees: box mean over its native cell, sampled at the 0.1 deg forecast points
    r = round(MODEL_STEP / FINE_STEP)
    for km in MODEL_KMS:
        half = max(1, round(km / (FINE_STEP * KM_PER_DEG) / 2))
        model = box_mean(fine, half)[::r, ::r]
        model_land = box_mean(land, half)[::r, ::r]
        assert model.shape == (MODEL_H, MODEL_W), model.shape
        files[f'sa-model-elevation-{km}km.png'] = encode_terrain(model, model_land)

    for name, png in files.items():
        with open(os.path.join(out_dir, name), 'wb') as f:
            f.write(png)
        print(f'  {name}: {len(png) / 1e3:.0f} KB')
    old = os.path.join(out_dir, 'sa-model-elevation.png')
    if os.path.exists(old):
        os.remove(old)  # replaced by the per-resolution files

    def grid(step, nx, ny):
        return {'latMax': LAT_MAX, 'latMin': LAT_MIN, 'lonMin': LON_MIN, 'lonMax': LON_MAX,
                'step': step, 'nx': nx, 'ny': ny}

    meta = {
        'fine': grid(FINE_STEP, FINE_W, FINE_H),
        'smooth': grid(SMOOTH_STEP, smooth.shape[1], smooth.shape[0]),
        'model': grid(MODEL_STEP, MODEL_W, MODEL_H),
        'modelKms': list(MODEL_KMS),
        'min': 0, 'max': ELEV_MAX, 'encoding': 'terrain-rgb',
    }
    with open(os.path.join(out_dir, 'sa-terrain.json'), 'w') as f:
        json.dump(meta, f, indent=1)


def round_coords(c, nd=4):
    return [round(c[0], nd), round(c[1], nd)] if isinstance(c[0], (int, float)) else [round_coords(k, nd) for k in c]


def simplified(geom, tol):
    g = geom.simplify(tol, preserve_topology=True)
    m = mapping(g)
    return {'type': m['type'], 'coordinates': round_coords(m['coordinates'])}


def build_districts(cache, out_path):
    base = 'https://github.com/wmgeolab/geoBoundaries/raw/main/releaseData/gbOpen/IND'
    a1 = json.load(open(fetch(f'{base}/ADM1/geoBoundaries-IND-ADM1_simplified.geojson',
                              os.path.join(cache, 'adm1.geojson')), encoding='utf-8'))
    a2 = json.load(open(fetch(f'{base}/ADM2/geoBoundaries-IND-ADM2_simplified.geojson',
                              os.path.join(cache, 'adm2.geojson')), encoding='utf-8'))

    states = {}
    for f in a1['features']:
        key = ascii_name(f['properties']['shapeName'])
        if key in STATES:
            states[STATES[key]] = shape(f['geometry'])
    missing = set(STATES.values()) - set(states)
    if missing:
        raise RuntimeError(f'states missing from source: {sorted(missing)}')

    features, counts = [], {s: 0 for s in states}
    for name, geom in states.items():
        features.append({'type': 'Feature', 'properties': {'kind': 'state', 'name': name},
                         'geometry': simplified(geom, 0.003)})

    # Sri Lanka: country outline only (drawn like the state outlines, and used for the click inspector)
    lka_url = 'https://github.com/wmgeolab/geoBoundaries/raw/main/releaseData/gbOpen/LKA/ADM0/geoBoundaries-LKA-ADM0_simplified.geojson'
    lka = json.load(open(fetch(lka_url, os.path.join(cache, 'lka-adm0.geojson')), encoding='utf-8'))
    lka_shape = unary_union([shape(f['geometry']) for f in lka['features']])
    features.append({'type': 'Feature', 'properties': {'kind': 'state', 'name': 'Sri Lanka'},
                     'geometry': simplified(lka_shape, 0.003)})

    districts = []
    # Sri Lanka's 25 districts (its internal borders), named like the Indian ones
    lka2_url = 'https://github.com/wmgeolab/geoBoundaries/raw/main/releaseData/gbOpen/LKA/ADM2/geoBoundaries-LKA-ADM2_simplified.geojson'
    lka2 = json.load(open(fetch(lka2_url, os.path.join(cache, 'lka-adm2.geojson')), encoding='utf-8'))
    for f in lka2['features']:
        g = shape(f['geometry'])
        districts.append(('Sri Lanka', ascii_name(f['properties']['shapeName']).strip(), g, g.representative_point()))
        counts.setdefault('Sri Lanka', 0)
        counts['Sri Lanka'] += 1

    for f in a2['features']:
        g = shape(f['geometry'])
        point = g.representative_point()
        owner = next((s for s, sg in states.items() if sg.contains(point)), None)
        if owner is None:  # island groups can miss every simplified state polygon: accept a mostly-inside match
            best = max(states.items(), key=lambda kv: g.intersection(kv[1]).area)
            owner = best[0] if g.intersection(best[1]).area >= 0.5 * g.area else None
        if owner is None:
            continue
        districts.append((owner, ascii_name(f['properties']['shapeName']).strip(), g, point))
        counts[owner] += 1

    # Boundaries and names for the click inspector only: the map itself shows no place names
    for owner, name, g, _ in districts:
        features.append({'type': 'Feature', 'properties': {'kind': 'district', 'name': name, 'state': owner},
                         'geometry': simplified(g, 0.0012)})

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump({'type': 'FeatureCollection', 'features': features}, f, separators=(',', ':'), ensure_ascii=False)
    print(f'districts: {len(districts)} in {sorted(counts.items())}, {os.path.getsize(out_path) / 1e3:.0f} KB')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join(tempfile.gettempdir(), 'si-data-cache'))
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    out_dir = os.path.join(ROOT, 'public', 'data')
    os.makedirs(out_dir, exist_ok=True)
    build_elevation(args.cache, out_dir)
    build_districts(args.cache, os.path.join(out_dir, 'south-india-districts.geojson'))
