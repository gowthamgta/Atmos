/**
 * Lightning strokes of the last fifteen minutes, from the Indian Lightning Detection Network (ILDN), Centre for Lightning and Thunderstorm
 * Studies, Tripura University (ildn.in). Their terms: free for non-commercial use, with attribution, and the data is not to be modified.
 *
 * The page's own map reads a small binary file: 32 bytes a stroke (time as a 64-bit float, then latitude, longitude and age in seconds as
 * 32-bit floats, then an id). ILDN has no push stream (its own map and app poll over HTTP), so live here is a quick poll: every five
 * seconds through our own address (the function /.netlify/functions/ildn; in development proxy.conf.json), which keeps the answer for five seconds, so ILDN is asked at most every
 * five seconds in all however many people look. ILDN publishes a batch about every 30-45 s, its strokes then 45-100 s old (measured
 * 22 Oct), so a new batch is on screen within about 5 s of ILDN having it. Between polls the strokes are aged locally, and a stroke flashes
 * when it first arrives (by its age it never would: none is younger than about 45 s when it comes).
 */
export const LIGHTNING_URL = '/.netlify/functions/ildn?ut=latest&span=15';
/** Only strokes this recent are shown (seconds). */
export const LIGHTNING_WINDOW_S = 900;

/**
 * The colour of a stroke by its age, newest brightest (as lightning maps usually show it): white in its first 2 minutes, then yellow,
 * orange and red to 15 minutes. [from seconds, colour, label]
 */
export const LIGHTNING_AGE_COLOURS: readonly (readonly [number, string, string])[] = [
  [0, '#ffffff', '0–2'],
  [120, '#ffe14d', '2–5'],
  [300, '#ff9a2e', '5–10'],
  [600, '#e8413a', '10–15'],
];
export const LIGHTNING_CREDIT = 'Lightning: ILDN, Tripura University (non-commercial use); older strokes where ILDN has none: IMD';

const RECORD_BYTES = 32;

export interface Stroke {
  lat: number;
  lon: number;
  /** Seconds since the stroke. */
  ageS: number;
  /** The stroke's own time (unix seconds), to know it again in the next poll. */
  t?: number;
  /** Seconds since it first arrived here (its flash runs then). */
  arrivedS?: number;
  /** From IMD's map (late, about 8 km), not ILDN. */
  imd?: boolean;
}

/** The key that knows a stroke again from one poll to the next. */
export const strokeKey = (s: Stroke): string => `${s.t ?? ''}|${s.lat.toFixed(4)}|${s.lon.toFixed(4)}`;

/** The strokes in a response, newest last, keeping only those no older than `maxAgeS`. */
export function decodeStrokes(buffer: ArrayBuffer, maxAgeS = LIGHTNING_WINDOW_S): Stroke[] {
  const view = new DataView(buffer);
  const n = Math.floor(buffer.byteLength / RECORD_BYTES);
  const out: Stroke[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * RECORD_BYTES;
    const t = view.getFloat64(o, true);
    const lat = view.getFloat32(o + 8, true);
    const lon = view.getFloat32(o + 12, true);
    const ageS = view.getFloat32(o + 16, true);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(ageS)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    if (ageS < 0 || ageS > maxAgeS) continue;
    out.push({ lat, lon, ageS, t });
  }
  return out;
}

export interface LightningFeatures {
  type: 'FeatureCollection';
  features: { type: 'Feature'; properties: { age: number; arrived: number }; geometry: { type: 'Point'; coordinates: number[] } }[];
}

/** The strokes as they are `elapsedS` seconds after they were fetched: older by that much, and gone once past the window. */
export function ageStrokes(strokes: readonly Stroke[], elapsedS: number, maxAgeS = LIGHTNING_WINDOW_S): Stroke[] {
  const out: Stroke[] = [];
  for (const s of strokes) {
    const ageS = s.ageS + elapsedS;
    if (ageS <= maxAgeS) out.push({ ...s, ageS, arrivedS: s.arrivedS === undefined ? undefined : s.arrivedS + elapsedS });
  }
  return out;
}

export function lightningGeoJson(strokes: readonly Stroke[]): LightningFeatures {
  return {
    type: 'FeatureCollection',
    features: strokes.map(s => ({
      type: 'Feature',
      properties: { age: Math.round(s.ageS * 10) / 10, arrived: Math.round((s.arrivedS ?? 999) * 10) / 10 },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    })),
  };
}

export async function loadLightning(url: string = LIGHTNING_URL): Promise<Stroke[] | null> {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    return decodeStrokes(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Lightning is drawn whenever the radar or the satellite picture is on (there is no switch for it). */
export function lightningShown(layers: readonly { id: string; active: boolean }[]): boolean {
  return layers.some(l => (l.id === 'radar' || l.id === 'satellite') && l.active);
}

/**
 * The strokes of a new poll, each with how long ago it first arrived: those already known keep theirs (aged by the time since the last
 * poll), new ones arrive now. The very first poll's strokes count as long arrived, so opening the map does not flash every bolt at once.
 */
export function markArrivals(fresh: readonly Stroke[], known: readonly Stroke[], sinceLastS: number, firstPoll: boolean): Stroke[] {
  const before = new Map(known.map(s => [strokeKey(s), s.arrivedS]));
  return fresh.map(s => {
    const was = before.get(strokeKey(s));
    const arrivedS = firstPoll ? 999 : was === undefined ? 0 : (was ?? 999) + sinceLastS;
    return { ...s, arrivedS };
  });
}

/** IMD's lightning (netlify/functions/imd-lightning.js: the stars of its "last 10 min" map, about 8 km apart at best). */
export const IMD_LIGHTNING_URL = '/.netlify/functions/imd-lightning';
/** IMD's map comes 10 to 20 minutes after its strokes: they are kept this long, as past strokes. */
export const IMD_WINDOW_S = 1800;
/** An IMD stroke this close to one of ILDN's is the same storm, already shown by ILDN: not drawn again. */
export const IMD_SAME_KM = 25;

export interface ImdLightning {
  /** The newest of the map's strokes, and how many minutes before it the map reaches. */
  timeMs: number;
  windowMin: number;
  points: [number, number][];
}

export async function loadImdLightning(url: string = IMD_LIGHTNING_URL): Promise<ImdLightning | null> {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    const j = (await res.json()) as { time?: string; windowMin?: number; points?: unknown };
    const timeMs = Date.parse(j.time ?? '');
    if (!Number.isFinite(timeMs) || !Array.isArray(j.points)) return null;
    const points = j.points.filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    return { timeMs, windowMin: j.windowMin ?? 10, points };
  } catch {
    return null;
  }
}

/**
 * IMD's strokes where ILDN has none (ILDN's are live and exact; IMD's come late and only to about 8 km): each kept where IMD put it, as a
 * past stroke aged from the middle of IMD's window, and gone after IMD_WINDOW_S. They are drawn no younger than ILDN's oldest class, so
 * they read as past lightning.
 */
export function imdStrokes(imd: ImdLightning | null, ildn: readonly Stroke[], nowMs: number): Stroke[] {
  if (!imd) return [];
  const ageS = (nowMs - (imd.timeMs - (imd.windowMin * 60_000) / 2)) / 1000;
  if (ageS < 0 || ageS > IMD_WINDOW_S) return [];
  const far = (lat: number, lon: number) =>
    ildn.every(s => Math.hypot((s.lat - lat) * 111.2, (s.lon - lon) * 111.2 * Math.cos((lat * Math.PI) / 180)) > IMD_SAME_KM);
  return imd.points.filter(([lat, lon]) => far(lat, lon)).map(([lat, lon]) => ({ lat, lon, ageS, arrivedS: 999, imd: true }));
}
