/** Point-in-polygon lookup over public/data/south-india-districts.geojson (pure functions, no DOM). */

type Ring = [number, number][];

export interface AreaShape {
  name: string;
  state: string;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  /** Polygons, each a list of rings (the first is the outer boundary, the rest are holes). */
  polygons: Ring[][];
}

export interface AreaIndex {
  districts: AreaShape[];
  states: AreaShape[];
}

export interface PlaceMatch {
  district: string | null;
  state: string | null;
}

interface GeoFeature {
  properties: { kind: string; name: string; state?: string };
  geometry: { type: string; coordinates: unknown };
}

export function pointInRing(ring: Ring, lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(rings: Ring[], lon: number, lat: number): boolean {
  return rings.length > 0 && pointInRing(rings[0], lon, lat) && !rings.slice(1).some(h => pointInRing(h, lon, lat));
}

function toShape(f: GeoFeature): AreaShape {
  const g = f.geometry;
  const polygons = (g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]) as Ring[][];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polygons) {
    for (const [x, y] of poly[0]) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { name: f.properties.name, state: f.properties.state ?? f.properties.name, bbox: [minX, minY, maxX, maxY], polygons };
}

export function buildAreaIndex(collection: { features: GeoFeature[] }): AreaIndex {
  const districts: AreaShape[] = [];
  const states: AreaShape[] = [];
  for (const f of collection.features) {
    if (f.properties.kind === 'district') districts.push(toShape(f));
    else if (f.properties.kind === 'state') states.push(toShape(f));
  }
  return { districts, states };
}

function containing(shapes: AreaShape[], lat: number, lon: number): AreaShape | null {
  for (const s of shapes) {
    const [x0, y0, x1, y1] = s.bbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    if (s.polygons.some(p => pointInPolygon(p, lon, lat))) return s;
  }
  return null;
}

/** District and state containing a point. Falls back to the state alone (islands, coastline gaps). */
export function findPlace(index: AreaIndex, lat: number, lon: number): PlaceMatch {
  const district = containing(index.districts, lat, lon);
  if (district) return { district: district.name, state: district.state };
  const state = containing(index.states, lat, lon);
  return { district: null, state: state?.name ?? null };
}
