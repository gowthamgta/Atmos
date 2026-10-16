/**
 * Lightning strokes of the last five minutes, from the Indian Lightning Detection Network (ILDN), Centre for Lightning and Thunderstorm
 * Studies, Tripura University (ildn.in). Their terms: free for non-commercial use, with attribution, and the data is not to be modified.
 *
 * The page's own map reads a small binary file: 32 bytes a stroke (time as a 64-bit float, then latitude, longitude and age in seconds as
 * 32-bit floats, then an id). ILDN has no push stream (its own map and app poll over HTTP), so live here is a quick poll: every ten
 * seconds through our own address (the function /.netlify/functions/ildn; in development proxy.conf.json), which keeps the answer for ten seconds, so ILDN is asked about every ten
 * seconds in all however many people look. Between polls the strokes are aged locally and a new one flashes.
 */
export const LIGHTNING_URL = '/.netlify/functions/ildn?ut=latest&span=5';
/** Only strokes this recent are shown (seconds). */
export const LIGHTNING_WINDOW_S = 300;
export const LIGHTNING_CREDIT = 'Lightning: ILDN, Tripura University (non-commercial use)';

const RECORD_BYTES = 32;

export interface Stroke {
  lat: number;
  lon: number;
  /** Seconds since the stroke. */
  ageS: number;
}

/** The strokes in a response, newest last, keeping only those no older than `maxAgeS`. */
export function decodeStrokes(buffer: ArrayBuffer, maxAgeS = LIGHTNING_WINDOW_S): Stroke[] {
  const view = new DataView(buffer);
  const n = Math.floor(buffer.byteLength / RECORD_BYTES);
  const out: Stroke[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * RECORD_BYTES;
    const lat = view.getFloat32(o + 8, true);
    const lon = view.getFloat32(o + 12, true);
    const ageS = view.getFloat32(o + 16, true);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(ageS)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    if (ageS < 0 || ageS > maxAgeS) continue;
    out.push({ lat, lon, ageS });
  }
  return out;
}

export interface LightningFeatures {
  type: 'FeatureCollection';
  features: { type: 'Feature'; properties: { age: number }; geometry: { type: 'Point'; coordinates: number[] } }[];
}

/** The strokes as they are `elapsedS` seconds after they were fetched: older by that much, and gone once past the window. */
export function ageStrokes(strokes: readonly Stroke[], elapsedS: number, maxAgeS = LIGHTNING_WINDOW_S): Stroke[] {
  const out: Stroke[] = [];
  for (const s of strokes) {
    const ageS = s.ageS + elapsedS;
    if (ageS <= maxAgeS) out.push({ lat: s.lat, lon: s.lon, ageS });
  }
  return out;
}

export function lightningGeoJson(strokes: readonly Stroke[]): LightningFeatures {
  return {
    type: 'FeatureCollection',
    features: strokes.map(s => ({ type: 'Feature', properties: { age: Math.round(s.ageS * 10) / 10 }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })),
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
