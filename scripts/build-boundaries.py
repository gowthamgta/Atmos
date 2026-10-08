"""
Builds the state and district outlines the map draws (and the click inspector names places with):

  public/data/south-india-districts.geojson   state outlines (every state and union territory of India, and Sri Lanka)
                                              and district polygons of the South Indian states with their state: the map
                                              draws the district lines of Tamil Nadu only

The terrain is built separately (pipeline/build_terrain.py) from the Copernicus DEM.

Sources (downloaded once, cached in --cache):
  * Boundaries: geoBoundaries gbOpen India ADM1/ADM2 (simplified), ODbL 1.0, derived from lgdirectory.gov.in.
    This release predates the 2022 Andhra Pradesh re-organisation (14 districts instead of 26) and has 30
    Karnataka districts. https://www.geoboundaries.org/

Usage:  python scripts/build-boundaries.py [--cache DIR]
Needs:  shapely
"""
import argparse
import json
import os
import tempfile
import unicodedata
import urllib.request

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# the South Indian states: their districts are kept (the click inspector names them)
STATES = {
    'Tamil Nadu': 'Tamil Nadu', 'Kerala': 'Kerala', 'Karnataka': 'Karnataka',
    'Andhra Pradesh': 'Andhra Pradesh', 'Telangana': 'Telangana', 'Puducherry': 'Puducherry',
    'Lakshadweep': 'Lakshadweep',
}


def ascii_name(s):
    return ''.join(c for c in unicodedata.normalize('NFKD', s) if not unicodedata.combining(c))


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


def round_coords(c, nd=4):
    return [round(c[0], nd), round(c[1], nd)] if isinstance(c[0], (int, float)) else [round_coords(k, nd) for k in c]


def simplified(geom, tol):
    g = geom.simplify(tol, preserve_topology=True)
    m = mapping(g)
    return {'type': m['type'], 'coordinates': round_coords(m['coordinates'])}


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

    # every state and union territory of India: its outline is drawn
    all_states = {}
    for f in a1['features']:
        key = ascii_name(f['properties']['shapeName']).strip()
        all_states[STATES.get(key, key)] = shape(f['geometry'])
    missing = set(STATES.values()) - set(all_states)
    if missing:
        raise RuntimeError(f'states missing from source: {sorted(missing)}')
    states = {name: g for name, g in all_states.items() if name in STATES.values()}   # owners of the districts kept

    features, counts = [], {s: 0 for s in states}
    for name, geom in all_states.items():
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
    build_districts(args.cache, os.path.join(out_dir, 'south-india-districts.geojson'))
