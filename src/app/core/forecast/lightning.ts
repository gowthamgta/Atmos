/**
 * Lightning strokes of the last five minutes, from the Indian Lightning Detection Network (ILDN), Centre for Lightning and Thunderstorm
 * Studies, Tripura University (ildn.in). Their terms: free for non-commercial use, with attribution, and the data is not to be modified.
 *
 * The page's own map reads a small binary file: 32 bytes a stroke (time as a 64-bit float, then latitude, longitude and age in seconds as
 * 32-bit floats, then an id). It goes through our own address (/ildn, see netlify.toml), which keeps it for a minute, so the network is
 * asked at most about once a minute however many people look.
 */
export const LIGHTNING_URL = '/ildn/imap-data.php?ut=latest&span=5';
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

export function lightningGeoJson(strokes: readonly Stroke[]): LightningFeatures {
  return {
    type: 'FeatureCollection',
    features: strokes.map(s => ({ type: 'Feature', properties: { age: Math.round(s.ageS) }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })),
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
