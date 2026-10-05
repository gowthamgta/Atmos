"""
Builds the static South India data files used by the forecast layer:

  public/data/sa-elevation-1km.png      terrain on a 0.01 deg (~1.1 km) grid, rg16 PNG, metres 0..4000
  public/data/sa-model-elevation.png    the same terrain averaged to the forecast grid (0.1 deg, 221 x 181)
  public/data/sa-terrain.json           grid geometry and value ranges of the two PNGs
  public/data/south-india-districts.geojson   state outlines, district polygons and district label points

Why two elevation grids: the forecast model (ECMWF IFS) sees each 0.1 deg cell as one flat block at its mean
height. The shader corrects temperature and humidity by (fine terrain - model terrain) per pixel, so it needs
both. The model grid's own orography is not published, so it is approximated by box-averaging the DEM over
each 0.1 deg cell.

Sources (downloaded once, cached in --cache):
  * Elevation: AWS "Terrain Tiles" (Terrarium encoding, z8 ~ 0.6 km/pixel), compiled from SRTM and other
    public DEMs. https://registry.opendata.aws/terrain-tiles/
  * Boundaries: geoBoundaries gbOpen India ADM1/ADM2 (simplified), ODbL 1.0, derived from lgdirectory.gov.in.
    This release predates the 2022 Andhra Pradesh re-organisation (14 districts instead of 26) and has 30
    Karnataka districts. https://www.geoboundaries.org/

Usage:  python scripts/build-south-india-data.py [--cache DIR]
Needs:  numpy, Pillow, shapely
"""
import argparse
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
sys.path.insert(0, os.path.join(ROOT, 'pipeline'))
from encode import encode_field  # noqa: E402  (rg16 PNG encoder shared with the forecast pipeline)

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

    mosaic = np.zeros(((y1 - y0 + 1) * TILE, (x1 - x0 + 1) * TILE), np.float32)
    for (x, y), p in zip(tiles, paths):
        rgb = np.array(Image.open(p).convert('RGB'), dtype=np.float32)
        elev = rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0
        mosaic[(y - y0) * TILE:(y - y0 + 1) * TILE, (x - x0) * TILE:(x - x0 + 1) * TILE] = elev
    mosaic = np.clip(mosaic, 0.0, ELEV_MAX - 1)  # sea-level floor; bathymetry is irrelevant here

    # Box-average the mosaic into cells centred on the target grid points, using an integral image.
    integral = np.zeros((mosaic.shape[0] + 1, mosaic.shape[1] + 1), np.float64)
    integral[1:, 1:] = mosaic.cumsum(0).cumsum(1)
    lon_edges = LON_MIN + (np.arange(FINE_W + 1) - 0.5) * FINE_STEP
    lat_edges = LAT_MAX - (np.arange(FINE_H + 1) - 0.5) * FINE_STEP
    xe = np.clip(np.rint(world_x(lon_edges) - x0 * TILE).astype(int), 0, mosaic.shape[1])
    ye = np.clip(np.rint(world_y(lat_edges) - y0 * TILE).astype(int), 0, mosaic.shape[0])
    xe[1:] = np.maximum(xe[1:], xe[:-1] + 1).clip(max=mosaic.shape[1])
    ye[1:] = np.maximum(ye[1:], ye[:-1] + 1).clip(max=mosaic.shape[0])
    total = (integral[np.ix_(ye[1:], xe[1:])] - integral[np.ix_(ye[:-1], xe[1:])]
             - integral[np.ix_(ye[1:], xe[:-1])] + integral[np.ix_(ye[:-1], xe[:-1])])
    area = np.outer(np.diff(ye), np.diff(xe)).astype(np.float64)
    fine = (total / area).astype(np.float32)

    # Mean over each 0.1 deg forecast cell (11 x 11 fine samples, half weight on the edges)
    k = np.array([0.5] + [1.0] * 9 + [0.5], np.float32) / 10.0
    r = round(MODEL_STEP / FINE_STEP)
    padded = np.pad(fine, ((5, 5), (0, 0)), mode='edge')
    rows = np.einsum('ijk,k->ij', np.lib.stride_tricks.sliding_window_view(padded, 11, axis=0)[::r], k)
    padded = np.pad(rows, ((0, 0), (5, 5)), mode='edge')
    model = np.einsum('ijk,k->ij', np.lib.stride_tricks.sliding_window_view(padded, 11, axis=1)[:, ::r], k)
    assert fine.shape == (FINE_H, FINE_W) and model.shape == (MODEL_H, MODEL_W), (fine.shape, model.shape)

    for name, arr in (('sa-elevation-1km.png', fine), ('sa-model-elevation.png', model)):
        png = encode_field(arr, 0.0, ELEV_MAX)
        with open(os.path.join(out_dir, name), 'wb') as f:
            f.write(png)
        print(f'  {name}: {arr.shape[1]}x{arr.shape[0]}, max {arr.max():.0f} m, {len(png) / 1e3:.0f} KB')

    meta = {
        'fine': {'latMax': LAT_MAX, 'latMin': LAT_MIN, 'lonMin': LON_MIN, 'lonMax': LON_MAX,
                 'step': FINE_STEP, 'nx': FINE_W, 'ny': FINE_H},
        'model': {'latMax': LAT_MAX, 'latMin': LAT_MIN, 'lonMin': LON_MIN, 'lonMax': LON_MAX,
                  'step': MODEL_STEP, 'nx': MODEL_W, 'ny': MODEL_H},
        'min': 0, 'max': ELEV_MAX, 'encoding': 'rg16',
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
    lka_point = lka_shape.representative_point()
    features.append({'type': 'Feature', 'properties': {'kind': 'label', 'name': 'Sri Lanka', 'state': 'Sri Lanka', 'rank': 1},
                     'geometry': {'type': 'Point', 'coordinates': round_coords([lka_point.x, lka_point.y])}})

    districts = []
    # Sri Lanka's 25 districts (its internal borders), named and ranked like the Indian ones
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

    # Label priority (1 = shown first when zooming in) from district size, ranked within each country
    areas = {'Sri Lanka': sorted(g.area for o, _, g, _ in districts if o == 'Sri Lanka'),
             'India': sorted(g.area for o, _, g, _ in districts if o != 'Sri Lanka')}
    for owner, name, g, point in districts:
        pool = areas['Sri Lanka' if owner == 'Sri Lanka' else 'India']
        rank = 1 if g.area >= pool[int(len(pool) * 0.66)] else 2 if g.area >= pool[int(len(pool) * 0.25)] else 3
        features.append({'type': 'Feature', 'properties': {'kind': 'district', 'name': name, 'state': owner},
                         'geometry': simplified(g, 0.0012)})
        features.append({'type': 'Feature',
                         'properties': {'kind': 'label', 'name': name, 'state': owner, 'rank': rank},
                         'geometry': {'type': 'Point', 'coordinates': round_coords([point.x, point.y])}})

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
