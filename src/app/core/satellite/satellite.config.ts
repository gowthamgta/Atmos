/**
 * Meteosat-9 imagery over all of India (EUMETSAT's Indian Ocean Data Coverage service, 45.5 E) from EUMETView, EUMETSAT's
 * public map service. It needs no key or login, allows cross-origin requests, and has a new image every 15 minutes.
 *
 * The overlay shows the European HRV RGB (high-resolution visible) by day and, when the visible picture goes dark, one
 * infrared picture by night that picks out the cold cloud tops and high cloud.
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

/** A box on the map in degrees. */
export interface GeoBounds {
  readonly west: number;
  readonly east: number;
  readonly south: number;
  readonly north: number;
}

/** The area requested: all of India (the forecast domain covers the same box). */
export const SATELLITE_BOUNDS: GeoBounds = { west: 68, east: 97.5, south: 5, north: 37.5 };
/** Pixels requested: a square picture of the box (about 1.6 km per pixel on desktop, 3 km on a phone). */
export const SATELLITE_SIZE = satelliteImageSize(isPhone());

export const SATELLITE_STEP_MIN = 15;
/** Fallback only: how old a frame must be to be safe when the service's own newest time is not known. */
export const SATELLITE_LAG_MIN = 25;
/** Frames in the loop: 5 x 15 min = the last hour (the first frame is exactly 60 minutes before the newest). */
export const SATELLITE_FRAME_COUNT = 5;

/** The pictures shown: Meteosat's HRV by day and infrared (10.8 µm) at night. */
export type SatelliteChannel = 'hrv' | 'ir';

export interface SatelliteProduct {
  id: SatelliteChannel;
  label: string;
  /** Layer name on EUMETView. */
  layer: string;
}

export const SATELLITE_HRV: SatelliteProduct = { id: 'hrv', label: 'European HRV RGB', layer: 'rgb_eview' };
export const SATELLITE_IR: SatelliteProduct = { id: 'ir', label: 'Infrared', layer: 'ir108' };

/** The satellite's name and credit, as shown in the menus and the panel. */
export const SATELLITE_NAME = 'Meteosat-9';
export const SATELLITE_CREDIT = '© EUMETSAT';

/** Centre of India, used to decide whether it is day or night over the area. */
const CENTRE = { lat: 20, lon: 79 };
/** Sun height (degrees) above which the visible picture is bright enough to use. */
export const DAYLIGHT_MIN_ELEVATION_DEG = 8;
/** Twilight elevation band (degrees) over which HRV and IR are smoothly blended across the solar terminator. */
export const TWILIGHT_BLEND_LO_DEG = 2;
export const TWILIGHT_BLEND_HI_DEG = 14;

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

/** The picture for a frame: HRV while the sun is up over India, infrared otherwise. */
export function productForTime(timeMs: number): SatelliteProduct {
  return sunElevationDeg(timeMs, CENTRE.lat, CENTRE.lon) >= DAYLIGHT_MIN_ELEVATION_DEG ? SATELLITE_HRV : SATELLITE_IR;
}

/** True when the solar terminator lies inside the satellite bounds, so HRV and IR should be blended per-column. */
export function isTwilightTime(timeMs: number, b = SATELLITE_BOUNDS): boolean {
  const westElev = sunElevationDeg(timeMs, CENTRE.lat, b.west);
  const eastElev = sunElevationDeg(timeMs, CENTRE.lat, b.east);
  const minE = Math.min(westElev, eastElev);
  const maxE = Math.max(westElev, eastElev);
  return maxE > TWILIGHT_BLEND_LO_DEG && minE < TWILIGHT_BLEND_HI_DEG;
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

/**
 * GetMap URL for one frame of `bounds` (all of India unless a closer window is asked for). JPEG keeps a frame to 20-400 KB (the
 * service compresses it hard and ignores any quality option, so it is blocky when magnified a lot); `lossless` asks for a PNG, about
 * 15 times the size, for a small window that will be magnified. Transparency is done afterwards, in the browser.
 */
export function satelliteFrameUrl(
  product: SatelliteProduct,
  timeMs: number,
  layer: string = product.layer,
  size: { width: number; height: number } = SATELLITE_SIZE,
  b: GeoBounds = SATELLITE_BOUNDS,
  lossless = false,
): string {
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: `msg_iodc:${layer}`,
    styles: '',
    crs: 'EPSG:4326',
    // WMS 1.3.0 with EPSG:4326 orders the box as south, west, north, east
    bbox: `${b.south},${b.west},${b.north},${b.east}`,
    width: String(size.width),
    height: String(size.height),
    format: lossless ? 'image/png' : 'image/jpeg',
    time: new Date(timeMs).toISOString().replace('.000Z', 'Z'),
  });
  return `${EUMETVIEW_WMS}?${params.toString()}`;
}
