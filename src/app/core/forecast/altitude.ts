import type { Level } from './forecast-layers';

/** The pressure at the tropopause of the International Standard Atmosphere (hPa), where its temperature stops falling with height. */
const P_TROPOPAUSE = 226.3206;
const FEET_PER_METRE = 1 / 0.3048;

/**
 * The height (metres) at which a pressure (hPa) occurs in the International Standard Atmosphere (ICAO Doc 7488): the "pressure altitude". It is
 * how every altitude chart and every aircraft reckons "how high is 700 hPa", whatever the real weather does to the level that day.
 */
export function isaHeightM(hPa: number): number {
  if (hPa >= P_TROPOPAUSE) return 44330.77 * (1 - Math.pow(hPa / 1013.25, 0.190263));  // troposphere: 6.5 K per km
  return 11000 - 6341.62 * Math.log(hPa / P_TROPOPAUSE);                                // stratosphere: 216.65 K all the way up to 20 km
}

/** The height of a pressure level as a round number of metres (the nearest 100): "3000", "4200". */
export function roundedMetres(hPa: number): number {
  return Math.round(isaHeightM(hPa) / 100) * 100;
}

/**
 * The flight level of a pressure level: its pressure altitude in hundreds of feet, to the nearest 5 (FL100 is 10 000 ft). A flight level is
 * defined by pressure, so this is exact up to the rounding, whatever the weather.
 */
export function flightLevel(hPa: number): number {
  return Math.round((isaHeightM(hPa) * FEET_PER_METRE) / 500) * 5;
}

/** What to call an altitude: the pressure, the height in metres, and the flight level (none at the ground). */
export interface AltitudeLabels {
  /** "700 hPa", or "Ground". */
  name: string;
  /** "3000 m", or "2–10 m" at the ground (the layers drawn there are 2 m temperature and 10 m wind). */
  metres: string;
  /** "FL100", absent at the ground. */
  flight: string | null;
}

export function altitudeLabels(level: Level): AltitudeLabels {
  if (level === 'surface') return { name: 'Ground', metres: '2–10 m', flight: null };
  return { name: `${level} hPa`, metres: `${roundedMetres(level)} m`, flight: `FL${flightLevel(level)}` };
}

/** The second line of the altitude button: "3000 m · FL100", or "2–10 m" at the ground. */
export function altitudeSubline(level: Level): string {
  const { metres, flight } = altitudeLabels(level);
  return flight ? `${metres} · ${flight}` : metres;
}
