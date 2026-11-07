/** Tropical-cyclone tracks near South India: ECMWF's forecast tracks, published by the pipeline (pipeline/cyclones.py). */
import { contourLines } from './contours';

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
  /** Ensemble members: [hour, lat, lon] every 12 h (not drawn: see pipeline/cyclones.py). */
  members: [number, number, number][][];
}

export interface CycloneData {
  version: number;
  run: string;
  storms: CycloneStorm[];
}

/**
 * IMD's classes of a low over the North Indian Ocean by its maximum sustained wind (m/s; IMD's limits are in knots: 17, 28, 34, 48, 64, 90 and
 * 120 kt), with a short name for the map and a colour that warms as the storm strengthens.
 */
export const CYCLONE_CLASSES: readonly { below: number; name: string; short: string; color: string }[] = [
  { below: 8.7, name: 'Low', short: 'L', color: '#9aa5b1' },
  { below: 14.4, name: 'Depression', short: 'D', color: '#5fb3e6' },
  { below: 17.5, name: 'Deep depression', short: 'DD', color: '#3fc0a6' },
  { below: 24.7, name: 'Cyclonic storm', short: 'CS', color: '#f2d23a' },
  { below: 32.9, name: 'Severe cyclonic storm', short: 'SCS', color: '#f6a13a' },
  { below: 46.3, name: 'Very severe cyclonic storm', short: 'VSCS', color: '#ef6a3a' },
  { below: 61.7, name: 'Extremely severe cyclonic storm', short: 'ESCS', color: '#d6336c' },
  { below: Infinity, name: 'Super cyclonic storm', short: 'SuCS', color: '#a23bd8' },
];

export function windClass(windMs: number | null): { name: string; short: string; color: string } {
  const w = windMs ?? 0;
  const c = CYCLONE_CLASSES.find(k => w < k.below) ?? CYCLONE_CLASSES[CYCLONE_CLASSES.length - 1];
  return { name: c.name, short: c.short, color: c.color };
}

/**
 * Radius (km) of the cone of a forecast position at `h` hours: the typical track error, two in three storms staying inside it (the US National
 * Hurricane Center's cone, which is what most track maps draw), widening with time.
 */
const CONE_KM: readonly [number, number][] = [
  [0, 20], [12, 48], [24, 72], [36, 98], [48, 120], [60, 146], [72, 165], [96, 239], [120, 333], [144, 420], [168, 500], [192, 580], [216, 650], [240, 720],
];

export function coneRadiusKm(h: number): number {
  if (h <= CONE_KM[0][0]) return CONE_KM[0][1];
  for (let i = 1; i < CONE_KM.length; i++) {
    const [h1, r1] = CONE_KM[i];
    if (h <= h1) {
      const [h0, r0] = CONE_KM[i - 1];
      return r0 + ((h - h0) / (h1 - h0)) * (r1 - r0);
    }
  }
  return CONE_KM[CONE_KM.length - 1][1];
}

/** The cone ends this many hours after the run, as the hurricane centres' does: further on the track is drawn, but its error is too large to be useful. */
export const CONE_HOURS = 120;

const KM_PER_DEG = 111.32;
const rad = (d: number) => (d * Math.PI) / 180;

/** The track as drawn: each position the mean of itself and its neighbours (a weak low wobbles from one 6-hour position to the next), ends kept. */
export function smoothTrack(track: readonly TrackPoint[]): TrackPoint[] {
  return track.map((p, i) => {
    if (i === 0 || i === track.length - 1) return p;
    const a = track[i - 1];
    const b = track[i + 1];
    return { ...p, lat: (a.lat + 2 * p.lat + b.lat) / 4, lon: (a.lon + 2 * p.lon + b.lon) / 4 };
  });
}

/**
 * The cone around a track as one outline: every place whose distance to the track is under the cone's radius there (coneRadiusKm, growing along
 * each leg), traced on a 0.1 degree grid (contours.ts), so the cone has no seams where pieces would overlap and a track that turns back on itself
 * still makes one cone. Rings as [lon, lat]; one polygon each.
 */
export function coneOutline(track: readonly TrackPoint[], step = 0.1): number[][][][] {
  if (track.length === 0) return [];
  const maxR = Math.max(...track.map(p => coneRadiusKm(p.h))) / KM_PER_DEG;
  const pad = maxR / Math.cos(rad(Math.max(...track.map(p => Math.abs(p.lat))))) + 3 * step;
  const lonMin = Math.min(...track.map(p => p.lon)) - pad;
  const lonMax = Math.max(...track.map(p => p.lon)) + pad;
  const latMin = Math.min(...track.map(p => p.lat)) - pad;
  const latMax = Math.max(...track.map(p => p.lat)) + pad;
  const nx = Math.ceil((lonMax - lonMin) / step) + 1;
  const ny = Math.ceil((latMax - latMin) / step) + 1;
  const field = new Float32Array(nx * ny);
  const legs = track.length === 1 ? [[track[0], track[0]]] : track.slice(1).map((b, i) => [track[i], b]);
  for (let y = 0; y < ny; y++) {
    const lat = latMax - y * step;
    const kx = Math.cos(rad(lat)) * KM_PER_DEG;
    for (let x = 0; x < nx; x++) {
      const lon = lonMin + x * step;
      let best = Infinity;
      for (const [a, b] of legs) {
        // the nearest point of the leg, on a flat map around this place (km), and the cone's radius there
        const ax = (a.lon - lon) * kx, ay = (a.lat - lat) * KM_PER_DEG;
        const bx = (b.lon - lon) * kx, by = (b.lat - lat) * KM_PER_DEG;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        const r = coneRadiusKm(a.h + t * (b.h - a.h));
        if (d - r < best) best = d - r;
      }
      field[y * nx + x] = best;
    }
  }
  const lines = contourLines(field, { latMax, latMin, lonMin, lonMax, step, nx, ny }, [0]);
  return lines.filter(l => l.closed && l.points.length >= 4).map(l => [l.points.map(([lo, la]) => [lo, la])]);
}

/** The storm at a time (hours after the run): its position and wind between the two forecast positions around it, or null outside the track. */
export function stormAt(track: readonly TrackPoint[], h: number): TrackPoint | null {
  if (track.length === 0 || h < track[0].h || h > track[track.length - 1].h) return null;
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (h >= a.h && h <= b.h) {
      const t = b.h === a.h ? 0 : (h - a.h) / (b.h - a.h);
      const mix = (x: number | null, y: number | null) => (x === null || y === null ? (x ?? y) : x + t * (y - x));
      return { h, lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon), pMsl: mix(a.pMsl, b.pMsl), wind: mix(a.wind, b.wind) };
    }
  }
  return track[track.length - 1];
}

/** The run's start time (ms) from its id ("20261022T00Z"); null when it cannot be read. */
export function runStartMs(run: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})Z$/.exec(run);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]) : null;
}

const dayFormat = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric' });

export interface CycloneFeature {
  type: 'Feature';
  properties: Record<string, string | number | boolean>;
  geometry:
    | { type: 'LineString'; coordinates: number[][] }
    | { type: 'Point'; coordinates: number[] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] };
}

export interface CycloneFeatures {
  type: 'FeatureCollection';
  features: CycloneFeature[];
}

/**
 * The tracks as map features: the cone of each storm (from the time on the bar onwards), the track in segments coloured by the storm's class, a
 * point every 12 h, a label each day (date, wind and class), and the storm where it is at the time on the bar (`timeMs`).
 */
export function cycloneGeoJson(data: CycloneData | null, timeMs: number | null = null): CycloneFeatures {
  const features: CycloneFeature[] = [];
  const start = data ? runStartMs(data.run) : null;
  const nowH = start !== null && timeMs !== null ? (timeMs - start) / 3_600_000 : null;
  for (const s of data?.storms ?? []) {
    if (s.track.length === 0) continue;
    const track = smoothTrack(s.track);
    const coneFrom = nowH !== null ? Math.max(nowH, track[0].h) : track[0].h;
    const cone = stormAt(track, coneFrom);
    const conePts = (cone ? [cone, ...track.filter(p => p.h > coneFrom)] : track).filter(p => p.h <= CONE_HOURS);
    if (conePts.length >= 1) {
      features.push({ type: 'Feature', properties: { kind: 'cone', storm: s.id }, geometry: { type: 'MultiPolygon', coordinates: coneOutline(conePts) } });
    }
    for (let i = 0; i + 1 < track.length; i++) {
      const a = track[i];
      const b = track[i + 1];
      const cls = windClass(Math.max(a.wind ?? 0, b.wind ?? 0));
      const past = nowH !== null && b.h <= nowH;
      features.push({
        type: 'Feature',
        properties: { kind: 'segment', storm: s.id, color: cls.color, past },
        geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
      });
    }
    const label = s.name && s.name !== s.id ? `${s.name} (${s.id})` : s.id;
    for (const p of track) {
      if (p.h % 12 !== 0) continue;
      const cls = windClass(p.wind);
      const day = p.h % 24 === 0;
      const when = start !== null ? dayFormat.format(new Date(start + p.h * 3_600_000)) : `+${p.h} h`;
      const kmh = p.wind === null ? '' : `${Math.round(p.wind * 3.6)} km/h`;
      features.push({
        type: 'Feature',
        properties: {
          kind: 'point', storm: s.id, h: p.h, color: cls.color, day, past: nowH !== null && p.h < nowH,
          label: day && p.h > 0 ? [when, [kmh, cls.short].filter(Boolean).join(' ')].join('\n') : '',
          // a label stronger in class wins a crowded spot
          rank: CYCLONE_CLASSES.findIndex(c => c.short === cls.short),
        },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      });
    }
    const here = nowH !== null ? stormAt(track, nowH) : null;
    if (here) {
      const cls = windClass(here.wind);
      const kmh = here.wind === null ? '' : ` · ${Math.round(here.wind * 3.6)} km/h`;
      features.push({
        type: 'Feature',
        properties: { kind: 'now', storm: s.id, color: cls.color, label: `${label}\n${cls.name}${kmh}${here.pMsl === null ? '' : ` · ${Math.round(here.pMsl)} hPa`}` },
        geometry: { type: 'Point', coordinates: [here.lon, here.lat] },
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
