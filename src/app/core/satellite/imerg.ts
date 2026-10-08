/**
 * Observed rain from NASA GPM IMERG: a rain-rate picture of the whole world every 30 minutes, made from the constellation of
 * microwave satellites and the geostationary infrared, at 0.1 degrees (about 10 km). The pictures reach NASA GIBS a few
 * hours after the observation. They need no key and allow cross-origin requests.
 */

export const IMERG_LAYER = 'IMERG_Precipitation_Rate_30min';
export const IMERG_SLOT_MS = 30 * 60_000;
/** The pictures are not there until roughly this long after their time. */
export const IMERG_LATENCY_MS = 4 * 3_600_000;
/** The finest tile level the layer has (GoogleMapsCompatible level 6). */
export const IMERG_MAX_ZOOM = 6;
/** How far back the picture can be stepped (hours) from the newest one. */
export const IMERG_HISTORY_H = 24;
/** A tile over South India, to ask whether a picture exists. */
export const IMERG_PROBE_TILE = { z: 4, x: 11, y: 7 };

/** The 30-minute slot a time falls in (start of the slot), ms. */
export function imergSlot(timeMs: number): number {
  return Math.floor(timeMs / IMERG_SLOT_MS) * IMERG_SLOT_MS;
}

/** GIBS time parameter, e.g. 2026-10-07T21:30:00Z. */
export function imergTimeParam(slotMs: number): string {
  return new Date(slotMs).toISOString().slice(0, 19) + 'Z';
}

export function imergTileUrl(slotMs: number, z: number, x: number, y: number): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${IMERG_LAYER}/default/${imergTimeParam(slotMs)}/GoogleMapsCompatible_Level6/${z}/${y}/${x}.png`;
}

/** The tile template handed to MapLibre. */
export function imergTemplate(slotMs: number): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${IMERG_LAYER}/default/${imergTimeParam(slotMs)}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`;
}

/** The slots to try for the newest picture, newest first: from the expected latency back over a few hours. */
export function imergCandidates(nowMs: number, count = 16): number[] {
  const first = imergSlot(nowMs - IMERG_LATENCY_MS + 2 * IMERG_SLOT_MS);
  return Array.from({ length: count }, (_, i) => first - i * IMERG_SLOT_MS);
}

/** Label of a slot in Indian time, e.g. "8 Oct, 03:00". */
export function imergLabelIst(slotMs: number): string {
  const ist = new Date(slotMs + 5.5 * 3_600_000);
  const month = ist.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  return `${ist.getUTCDate()} ${month}, ${hh}:${mm}`;
}
