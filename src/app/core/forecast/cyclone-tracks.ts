/** Tropical-cyclone tracks near South India: ECMWF's forecast tracks, published by the pipeline (pipeline/cyclones.py). */

export const CYCLONE_URL = 'https://gowthamgta.github.io/Atmos/cyclones/tracks.json';

export interface TrackPoint {
  h: number;
  lat: number;
  lon: number;
  pMsl: number | null;
  wind: number | null;
}

export interface CycloneStorm {
  id: string;
  name: string;
  basin: string;
  track: TrackPoint[];
  /** Ensemble members: [hour, lat, lon] every 12 h. */
  members: [number, number, number][][];
}

export interface CycloneData {
  version: number;
  run: string;
  storms: CycloneStorm[];
}

/** IMD's classes by 10 m wind (m/s): 17.5 depression, 24.7 deep depression, 33 cyclonic storm, 46 severe, 61.7 very severe, then extremely severe. */
const CLASSES: readonly [number, string, string][] = [
  [17.5, 'Low', '#8fb6d9'],
  [24.7, 'Depression', '#4fc3a1'],
  [33, 'Deep depression', '#e0d23a'],
  [46, 'Cyclonic storm', '#f2a03a'],
  [61.7, 'Severe cyclonic storm', '#ee5a3a'],
  [Infinity, 'Very severe or stronger', '#c2185b'],
];

export function windClass(windMs: number | null): { name: string; color: string } {
  const w = windMs ?? 0;
  const c = CLASSES.find(([limit]) => w < limit) ?? CLASSES[CLASSES.length - 1];
  return { name: c[1], color: c[2] };
}

export interface CycloneFeature {
  type: 'Feature';
  properties: Record<string, string | number | boolean>;
  geometry: { type: 'LineString'; coordinates: number[][] } | { type: 'Point'; coordinates: number[] };
}

export interface CycloneFeatures {
  type: 'FeatureCollection';
  features: CycloneFeature[];
}

/** The data as map features: the ensemble spread, the main track as a line, and a point at every 6 h with its class and (every 24 h) a label. */
export function cycloneGeoJson(data: CycloneData | null): CycloneFeatures {
  const features: CycloneFeature[] = [];
  for (const s of data?.storms ?? []) {
    for (const m of s.members) {
      if (m.length < 2) continue;
      features.push({ type: 'Feature', properties: { kind: 'member', storm: s.id }, geometry: { type: 'LineString', coordinates: m.map(p => [p[2], p[1]]) } });
    }
    if (s.track.length >= 2) {
      features.push({ type: 'Feature', properties: { kind: 'track', storm: s.id }, geometry: { type: 'LineString', coordinates: s.track.map(p => [p.lon, p.lat]) } });
    }
    for (const p of s.track) {
      const cls = windClass(p.wind);
      const day = p.h > 0 && p.h % 24 === 0;
      const speed = p.wind === null ? '' : `${Math.round(p.wind * 3.6)} km/h`;
      const label = p.h === 0
        ? `${s.name && s.name !== s.id ? s.name + ' ' : ''}${s.id}`
        : day ? `+${p.h / 24} d${p.pMsl === null ? '' : ` · ${Math.round(p.pMsl)} hPa`}` : '';
      features.push({
        type: 'Feature',
        properties: { kind: 'point', storm: s.id, h: p.h, color: cls.color, className: cls.name, speed, label, big: p.h === 0 || day },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

export async function loadCyclones(url: string = CYCLONE_URL): Promise<CycloneData | null> {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    const j = (await res.json()) as CycloneData;
    return Array.isArray(j.storms) ? j : null;
  } catch {
    return null;
  }
}
