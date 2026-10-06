/**
 * Two live satellites over the region, both from public map services that need no key or login and allow cross-origin requests:
 *  - Meteosat-9 (EUMETSAT's Indian Ocean Data Coverage service, 45.5 E) from EUMETView: a new image every 15 minutes.
 *  - Himawari-9 (JMA, 140.7 E) from NASA GIBS: a new image every 10 minutes, about 40 to 60 minutes behind real time. India is
 *    near the edge of its view, so its pictures are coarser (about 2 km) than Meteosat-9's here, but they come more often.
 *
 * The Meteosat overlay
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

export const SATELLITE_STEP_MIN = 15;
/** Fallback only: how old a frame must be to be safe when the service's own newest time is not known. */
export const SATELLITE_LAG_MIN = 25;
/** Frames in the loop: 5 x 15 min = the last hour (the first frame is exactly 60 minutes before the newest). */
export const SATELLITE_FRAME_COUNT = 5;

/** The pictures shown: Meteosat's HRV by day, Himawari's red visible (`vis`) by day, infrared (`ir`) at night. */
export type SatelliteChannel = 'hrv' | 'vis' | 'ir';

export type SatelliteSource = 'meteosat' | 'himawari';

export interface SatelliteProduct {
  id: SatelliteChannel;
  label: string;
  /** Layer name on the service (EUMETView workspace msg_iodc, or a NASA GIBS layer). */
  layer: string;
  source: SatelliteSource;
}

export const SATELLITE_HRV: SatelliteProduct = { id: 'hrv', label: 'European HRV RGB', layer: 'rgb_eview', source: 'meteosat' };
export const SATELLITE_IR: SatelliteProduct = { id: 'ir', label: 'Infrared', layer: 'ir108', source: 'meteosat' };
export const HIMAWARI_VIS: SatelliteProduct = { id: 'vis', label: 'Red visible', layer: 'Himawari_AHI_Band3_Red_Visible_1km', source: 'himawari' };
export const HIMAWARI_IR: SatelliteProduct = { id: 'ir', label: 'Clean infrared', layer: 'Himawari_AHI_Band13_Clean_Infrared', source: 'himawari' };

export interface SatelliteSourceInfo {
  id: SatelliteSource;
  label: string;
  /** Minutes between pictures, and how many make the loop (the last hour). */
  stepMin: number;
  frameCount: number;
  credit: string;
}

export const SATELLITE_SOURCES: Record<SatelliteSource, SatelliteSourceInfo> = {
  meteosat: { id: 'meteosat', label: 'Meteosat-9', stepMin: SATELLITE_STEP_MIN, frameCount: SATELLITE_FRAME_COUNT, credit: '© EUMETSAT' },
  himawari: { id: 'himawari', label: 'Himawari-9', stepMin: 10, frameCount: 7, credit: 'JMA Himawari-9 via NASA GIBS' },
};

export const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
/** Himawari pictures are about 2 km per pixel over India, so there is no use asking for more than about 1.5 km. */
export const HIMAWARI_SIZE = isPhone() ? { width: 1100, height: 900 } : { width: 1650, height: 1350 };
/** Most steps back the newest available Himawari picture is looked for (GIBS is 40 to 60 minutes behind). */
export const HIMAWARI_PROBE_STEPS = 12;
export const HIMAWARI_PROBE_START_LAG_MIN = 20;

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
export function productForTime(timeMs: number, source: SatelliteSource = 'meteosat'): SatelliteProduct {
  const day = sunElevationDeg(timeMs, CENTRE.lat, CENTRE.lon) >= DAYLIGHT_MIN_ELEVATION_DEG;
  if (source === 'himawari') return day ? HIMAWARI_VIS : HIMAWARI_IR;
  return day ? SATELLITE_HRV : SATELLITE_IR;
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
export function satelliteFrameUrl(product: SatelliteProduct, timeMs: number): string {
  if (product.source === 'himawari') return himawariUrl(product, timeMs, 'image/jpeg', HIMAWARI_SIZE.width, HIMAWARI_SIZE.height, false);
  const b = SATELLITE_BOUNDS;
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: `msg_iodc:${product.layer}`,
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

/** GIBS GetMap URL of a Himawari picture of the region. */
export function himawariUrl(product: SatelliteProduct, timeMs: number, format: string, width: number, height: number, transparent: boolean): string {
  const b = SATELLITE_BOUNDS;
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.3.0',
    LAYERS: product.layer,
    STYLES: '',
    CRS: 'EPSG:4326',
    BBOX: `${b.south},${b.west},${b.north},${b.east}`,
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: format,
    TIME: new Date(timeMs).toISOString().replace('.000Z', 'Z'),
  });
  if (transparent) params.set('TRANSPARENT', 'true');
  return `${GIBS_WMS}?${params.toString()}`;
}

/** A tiny transparent-PNG request for a Himawari time: GIBS answers a time it does not have yet with a fully empty picture of a few hundred bytes. */
export function himawariProbeUrl(product: SatelliteProduct, timeMs: number): string {
  return himawariUrl(product, timeMs, 'image/png', 44, 36, true);
}

/** A probe answer this small (bytes) is the empty picture: the time is not available yet. */
export const HIMAWARI_EMPTY_BYTES = 400;

/** Candidate times for the newest Himawari picture, newest first: on the 10-minute grid, from `HIMAWARI_PROBE_START_LAG_MIN` back. */
export function himawariCandidates(nowMs: number): number[] {
  const step = SATELLITE_SOURCES.himawari.stepMin * 60_000;
  const first = Math.floor((nowMs - HIMAWARI_PROBE_START_LAG_MIN * 60_000) / step) * step;
  return Array.from({ length: HIMAWARI_PROBE_STEPS }, (_, i) => first - i * step);
}
