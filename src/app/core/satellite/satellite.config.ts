/**
 * Meteosat-9 imagery (EUMETSAT's Indian Ocean Data Coverage service, 45.5 E) from EUMETView, EUMETSAT's public map
 * service. It needs no key or login, allows cross-origin requests, and has a new image every 15 minutes.
 *
 * The overlay shows the European HRV RGB (high-resolution visible) by day and the infrared channel by night,
 * when the visible picture goes dark.
 *
 * Two quirks shaped this module:
 *  - Asking for a time the server does not have yet silently returns the newest image, which can still be
 *    partly assembled (visible seams). So the app only ever asks for frames at least `SATELLITE_LAG_MIN` old.
 *  - Images are plain latitude/longitude, so the map layer must place them with the Mercator correction
 *    (see SatelliteImageLayer), not as a stretched rectangle.
 */

export const EUMETVIEW_WMS = 'https://view.eumetsat.int/geoserver/msg_iodc/wms';

/** The area requested: South India, Sri Lanka and the seas around them (same as the forecast domain). */
export const SATELLITE_BOUNDS = { west: 68, east: 90, south: 4, north: 22 } as const;
/** Pixels requested (about 2 km per pixel; the satellite's high-resolution visible channel sees about 1-3 km here). */
export const SATELLITE_SIZE = { width: 1100, height: 900 } as const;

export const SATELLITE_STEP_MIN = 15;
/** How long after its start a frame is safe to use (the satellite scans for ~12 min, then it is processed). */
export const SATELLITE_LAG_MIN = 35;
/** Frames in the loop: 12 x 15 min = 3 hours. */
export const SATELLITE_FRAME_COUNT = 12;

/** The two pictures shown: HRV by day, infrared at night. */
export type SatelliteChannel = 'hrv' | 'ir';

export interface SatelliteProduct {
  id: SatelliteChannel;
  label: string;
  /** Layer name on EUMETView (workspace msg_iodc). */
  layer: string;
  /**
   * How the picture becomes an overlay. `dark-fade`: only near-black is see-through (colour images);
   * `luma`: transparency follows brightness, so clear ground is see-through and clouds are opaque.
   */
  mode: 'luma' | 'dark-fade';
}

export const SATELLITE_HRV: SatelliteProduct = { id: 'hrv', label: 'European HRV RGB', layer: 'rgb_eview', mode: 'dark-fade' };
export const SATELLITE_IR: SatelliteProduct = { id: 'ir', label: 'Infrared', layer: 'ir108', mode: 'luma' };

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

/** GetMap URL for one frame. JPEG keeps a frame to 20-110 KB; transparency is done in the shader. */
export function satelliteFrameUrl(product: SatelliteProduct, timeMs: number): string {
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
