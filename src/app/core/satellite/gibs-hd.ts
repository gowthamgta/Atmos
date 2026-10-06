/**
 * High-detail true-colour satellite pictures from NASA GIBS (Global Imagery Browse Services): corrected reflectance from the
 * polar-orbiting VIIRS and MODIS instruments at 250 m per pixel, about 4 to 8 times sharper than the weather satellites.
 * They need no key and allow cross-origin requests. A polar orbiter passes over India once a day (about 10:30 to 13:30
 * local time), so this is a daily snapshot, not a live picture: each day's picture is the latest pass of that UTC day.
 *
 * The tiles are JPEG with no transparency, and where a day has no pass they are black; the map layer turns such black into
 * see-through (see `blackToTransparent`), so the base map shows through the gaps.
 */

export interface GibsSensor {
  id: string;
  label: string;
  /** GIBS layer name. */
  layer: string;
  /** Approximate local solar time of the pass over India, for the label. */
  pass: string;
}

export const GIBS_SENSORS: readonly GibsSensor[] = [
  { id: 'noaa21', label: 'VIIRS · NOAA-21', layer: 'VIIRS_NOAA21_CorrectedReflectance_TrueColor', pass: 'about 1:30 pm' },
  { id: 'snpp', label: 'VIIRS · Suomi NPP', layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', pass: 'about 1:30 pm' },
  { id: 'noaa20', label: 'VIIRS · NOAA-20', layer: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor', pass: 'about 1:30 pm' },
  { id: 'terra', label: 'MODIS · Terra', layer: 'MODIS_Terra_CorrectedReflectance_TrueColor', pass: 'about 10:30 am' },
  { id: 'aqua', label: 'MODIS · Aqua', layer: 'MODIS_Aqua_CorrectedReflectance_TrueColor', pass: 'about 1:30 pm' },
];

export const GIBS_DEFAULT_SENSOR = 'noaa21';

/** The tile matrix of 250 m imagery: zoom 9 is the finest; the map magnifies it beyond that. */
export const GIBS_MAX_ZOOM = 9;
export const GIBS_TILE_SIZE = 256;

/** Custom MapLibre protocol the tiles are fetched through (see `registerGibsProtocol`). */
export const GIBS_PROTOCOL = 'gibs-hd';

/** UTC date of a day offset (0 today, 1 yesterday...) as YYYY-MM-DD. */
export function gibsDate(nowMs: number, daysAgo: number): string {
  return new Date(nowMs - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/** The real GIBS tile address (Web Mercator, level 9 tile matrix set). */
export function gibsTileUrl(layer: string, date: string, z: number, x: number, y: number): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible_Level9/${z}/${y}/${x}.jpg`;
}

/** The tile template handed to MapLibre: the custom protocol, which fetches the real tile and clears its black. */
export function gibsTemplate(layer: string, date: string): string {
  return `${GIBS_PROTOCOL}://${layer}/${date}/{z}/{x}/{y}`;
}

/** Splits a protocol URL made from `gibsTemplate` back into its parts. */
export function parseGibsUrl(url: string): { layer: string; date: string; z: number; x: number; y: number } | null {
  const m = /^gibs-hd:\/\/([A-Za-z0-9_]+)\/(\d{4}-\d{2}-\d{2})\/(\d+)\/(\d+)\/(\d+)/.exec(url);
  return m ? { layer: m[1], date: m[2], z: +m[3], x: +m[4], y: +m[5] } : null;
}

/** Largest sum of the three colour channels still counted as "no data" black. */
export const NO_DATA_MAX_SUM = 9;

/**
 * Makes the black no-data pixels of a tile see-through (in place, RGBA). Edges are feathered a little: a pixel that is
 * nearly black next to no data fades, so the cut does not leave a dark fringe.
 */
export function blackToTransparent(px: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    const sum = px[i] + px[i + 1] + px[i + 2];
    if (sum <= NO_DATA_MAX_SUM) px[i + 3] = 0;
    else if (sum <= NO_DATA_MAX_SUM + 24) px[i + 3] = Math.round((255 * (sum - NO_DATA_MAX_SUM)) / 24);
  }
}

/** Whether a tile is empty (all black) so the day has no picture there; `sample` is a tile's RGBA. */
export function isEmptyTile(px: Uint8ClampedArray): boolean {
  let lit = 0;
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > NO_DATA_MAX_SUM) lit++;
  return lit < n * 0.02;
}

/** A tile in the middle of the region (zoom 5), used to see whether a day has a picture yet. */
export const GIBS_PROBE_TILE = { z: 5, x: 22, y: 14 };
