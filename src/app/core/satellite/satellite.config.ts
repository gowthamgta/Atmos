/**
 * The satellite box, the two kinds of picture (the visible by day, the infrared at night) and when it is day over India. Our pictures are made
 * by the satellite workflow (own-products.ts) on this box, in plain latitude and longitude, and re-spaced to Mercator in the browser.
 */

/** A box on the map in degrees. */
export interface GeoBounds {
  readonly west: number;
  readonly east: number;
  readonly south: number;
  readonly north: number;
}

/** The satellite pictures' box: all of India (the forecast domain covers the same box). */
export const SATELLITE_BOUNDS: GeoBounds = { west: 68, east: 97.5, south: 5, north: 37.5 };

/** The pictures shown: Meteosat's HRV by day and infrared (10.8 µm) at night. */
export type SatelliteChannel = 'hrv' | 'ir';

export interface SatelliteProduct {
  id: SatelliteChannel;
  label: string;
}

export const SATELLITE_HRV: SatelliteProduct = { id: 'hrv', label: 'Visible (HRV)' };
export const SATELLITE_IR: SatelliteProduct = { id: 'ir', label: 'Infrared' };

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

/** The closest the map zooms while the satellite is on: past this the picture (1.3 km a pixel at best) is only blur; Windy stops about here. */
export const SATELLITE_MAX_ZOOM = 11;
/** How close the map zooms with any other layer. */
export const MAP_MAX_ZOOM = 15;
