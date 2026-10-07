/**
 * Meteosat-9 imagery (EUMETSAT's Indian Ocean Data Coverage service, 45.5 E) from EUMETView, EUMETSAT's public map
 * service. It needs no key or login, allows cross-origin requests, and has a new image every 15 minutes.
 *
 * The overlay shows the European HRV RGB (high-resolution visible) by day and the infrared channel by night,
 * when the visible picture goes dark.
 *
 * Two quirks shaped this module:
 *  - Asking for a time the server does not have yet silently returns the newest image, which can still be
 *    partly assembled (visible seams). So the app asks the service for its newest listed time (a tiny request) and
 *    only falls back to a clock-based guess, `SATELLITE_LAG_MIN` behind, if that request fails.
 *  - Images are plain latitude/longitude, so they are re-spaced to Mercator before they go on the map
 *    (see satellite-image.ts), not stretched as a rectangle.
 */

import { isPhone, satelliteImageSize } from '../ui/device-profile';

export const EUMETVIEW_WMS = 'https://view.eumetsat.int/geoserver/msg_iodc/wms';

/** The area requested: South India, Sri Lanka and the seas around them (same as the forecast domain). */
export const SATELLITE_BOUNDS = { west: 68, east: 90, south: 4, north: 22 } as const;
/**
 * Pixels requested: about 1 km per pixel, finer than the satellite's own pixels (about 2-3 km here), so nothing is lost.
 * Phones get a quarter of the pixels (about 2 km per pixel): five full-size pictures would take over 80 MB of GPU memory.
 */
export const SATELLITE_SIZE = satelliteImageSize(isPhone());

/**
 * EUMETSAT's "enhanced natural colour" picture: true colour (green land, blue sea, white cloud), built from 3 km channels.
 * By day it helps the cloud-only view find low cloud (white in it, yellow like the land in the HRV picture).
 */
export const SATELLITE_NATURAL_LAYER = 'rgb_naturalenhncd';

export const SATELLITE_STEP_MIN = 15;
/** Fallback only: how old a frame must be to be safe when the service's own newest time is not known. */
export const SATELLITE_LAG_MIN = 25;
/** Frames in the loop: 5 x 15 min = the last hour (the first frame is exactly 60 minutes before the newest). */
export const SATELLITE_FRAME_COUNT = 5;

/** The pictures shown: Meteosat's HRV or FY-4B's true colour (`rgb`) by day, infrared at night. */
export type SatelliteChannel = 'hrv' | 'rgb' | 'ir';

/** The two satellites: Meteosat-9 (EUMETSAT's map service) and FY-4B (pictures the pipeline builds from NSMC's, see pipeline/fy4.py). */
export type SatelliteSource = 'meteosat' | 'fy4b';

export interface SatelliteProduct {
  id: SatelliteChannel;
  label: string;
  /** Layer name on EUMETView (workspace msg_iodc); empty for FY-4B. */
  layer: string;
  source: SatelliteSource;
}

export const SATELLITE_HRV: SatelliteProduct = { id: 'hrv', label: 'European HRV RGB', layer: 'rgb_eview', source: 'meteosat' };
export const SATELLITE_IR: SatelliteProduct = { id: 'ir', label: 'Infrared', layer: 'ir108', source: 'meteosat' };
export const FY4B_RGB: SatelliteProduct = { id: 'rgb', label: 'True colour', layer: '', source: 'fy4b' };
export const FY4B_IR: SatelliteProduct = { id: 'ir', label: 'Infrared', layer: '', source: 'fy4b' };

export interface SatelliteSourceInfo {
  id: SatelliteSource;
  label: string;
  credit: string;
}

export const SATELLITE_SOURCES: Record<SatelliteSource, SatelliteSourceInfo> = {
  meteosat: { id: 'meteosat', label: 'Meteosat-9', credit: '© EUMETSAT' },
  fy4b: { id: 'fy4b', label: 'FY-4B', credit: 'FY-4B AGRI, NSMC / CMA' },
};

/** Where the pipeline publishes the FY-4B pictures (same Pages site as the forecast data). */
export const FY4B_BASE = 'https://gowthamgta.github.io/Atmos/fy4';

/** One FY-4B picture as listed in `latest.json`. */
export interface Fy4Frame {
  /** ISO time of the scan. */
  time: string;
  kind: 'day' | 'night';
  /** File names next to latest.json: the full-size picture and the phone-size one. */
  hd: string;
  lite: string;
}

/** The FY-4B `latest.json`, checked: only frames with a readable time and both file names are kept, oldest first. */
export function parseFy4State(json: unknown): Fy4Frame[] {
  const frames = (json as { frames?: unknown })?.frames;
  if (!Array.isArray(frames)) return [];
  const ok = frames.filter((f): f is Fy4Frame =>
    !!f && typeof f.time === 'string' && !Number.isNaN(Date.parse(f.time)) && (f.kind === 'day' || f.kind === 'night') &&
    typeof f.hd === 'string' && typeof f.lite === 'string' && !/[\/]/.test(f.hd) && !/[\/]/.test(f.lite));
  return ok.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

export function fy4PictureUrl(frame: Fy4Frame, phone: boolean): string {
  return `${FY4B_BASE}/${phone ? frame.lite : frame.hd}`;
}

export function fy4ProductFor(frame: Fy4Frame): SatelliteProduct {
  return frame.kind === 'day' ? FY4B_RGB : FY4B_IR;
}

/**
 * What is drawn. `clouds`: only the cloud, bright and clean over the map (land and sea are see-through).
 * `picture`: the whole satellite picture (HRV keeps its land and sea colours).
 */
export type SatelliteView = 'clouds' | 'picture';

/** Domain centre, used to decide whether it is day or night over the area. */
const CENTRE = { lat: 13, lon: 79 };
/** Sun height (degrees) above which the visible picture is bright enough to use. */
export const DAYLIGHT_MIN_ELEVATION_DEG = 8;

/** Height of the sun above the horizon in degrees for a place and time (simple solar-position formula, about 1 degree accurate). */
export function sunElevationDeg(timeMs: number, latDeg: number, lonDeg: number): number {
  const rad = Math.PI / 180;
  const dayOfYear = (timeMs - Date.UTC(new Date(timeMs).getUTCFullYear(), 0, 0)) / 86_400_000;
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1);
  const declination =
    0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const eqTimeMin =
    229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const utcMin = new Date(timeMs).getUTCHours() * 60 + new Date(timeMs).getUTCMinutes();
  const solarTimeMin = utcMin + eqTimeMin + 4 * lonDeg;
  const hourAngle = (solarTimeMin / 4 - 180) * rad;
  const sinElevation =
    Math.sin(latDeg * rad) * Math.sin(declination) +
    Math.cos(latDeg * rad) * Math.cos(declination) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinElevation))) / rad;
}

/** The picture for a frame: HRV while the sun is up over South India, infrared otherwise. */
export function productForTime(timeMs: number): SatelliteProduct {
  return sunElevationDeg(timeMs, CENTRE.lat, CENTRE.lon) >= DAYLIGHT_MIN_ELEVATION_DEG ? SATELLITE_HRV : SATELLITE_IR;
}

/** Capabilities document of a layer: tiny, and it lists the newest time the service really has. */
export function satelliteCapabilitiesUrl(product: SatelliteProduct): string {
  return `https://view.eumetsat.int/geoserver/msg_iodc/${product.layer}/ows?service=WMS&version=1.3.0&request=GetCapabilities`;
}

/**
 * The newest time the service lists, from its capabilities document (a `start/end/period` or a plain list of times).
 * Returns null when the document has no time dimension.
 */
export function parseNewestTime(capabilitiesXml: string): number | null {
  const m = /<Dimension[^>]*\sname=["']time["'][^>]*>([^<]+)<\/Dimension>/i.exec(capabilitiesXml);
  if (!m) return null;
  let newest = NaN;
  for (const part of m[1].split(',')) {
    const pieces = part.trim().split('/');
    const end = Date.parse(pieces.length >= 2 ? pieces[1] : pieces[0]);
    if (!Number.isNaN(end)) newest = Number.isNaN(newest) ? end : Math.max(newest, end);
  }
  return Number.isNaN(newest) ? null : newest;
}

/** Epoch ms of the newest frame that is safe to request: `lagMin` before now, rounded down to a 15-minute slot. */
export function latestFrameTime(nowMs: number, lagMin = SATELLITE_LAG_MIN, stepMin = SATELLITE_STEP_MIN): number {
  const step = stepMin * 60_000;
  return Math.floor((nowMs - lagMin * 60_000) / step) * step;
}

/** The loop's frame times, oldest first, ending at `latestMs`. */
export function frameTimes(latestMs: number, count = SATELLITE_FRAME_COUNT, stepMin = SATELLITE_STEP_MIN): number[] {
  const step = stepMin * 60_000;
  return Array.from({ length: count }, (_, i) => latestMs - (count - 1 - i) * step);
}

/** GetMap URL for one frame. JPEG keeps a frame to 20-400 KB; transparency is done afterwards, in the browser. */
export function satelliteFrameUrl(product: SatelliteProduct, timeMs: number, layer: string = product.layer): string {
  const b = SATELLITE_BOUNDS;
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: `msg_iodc:${layer}`,
    styles: '',
    crs: 'EPSG:4326',
    // WMS 1.3.0 with EPSG:4326 orders the box as south, west, north, east
    bbox: `${b.south},${b.west},${b.north},${b.east}`,
    width: String(SATELLITE_SIZE.width),
    height: String(SATELLITE_SIZE.height),
    format: 'image/jpeg',
    time: new Date(timeMs).toISOString().replace('.000Z', 'Z'),
  });
  return `${EUMETVIEW_WMS}?${params.toString()}`;
}
