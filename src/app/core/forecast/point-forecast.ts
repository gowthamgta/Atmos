import { degToCompass } from '../domain/models/compass';
import { TerrainMode, applyTerrain } from './terrain-correction';

/** Variables read for a clicked point (pipeline ids). */
export const INSPECT_VARS = ['t2m', 'feels', 'rh', 'u10', 'v10', 'gust', 'precip', 'cloud', 'msl', 'cape', 'u850', 'v850', 'u500', 'v500'] as const;
export type InspectVar = (typeof INSPECT_VARS)[number];

export interface PointRow {
  id: string;
  label: string;
  /** Preformatted value including the unit. */
  text: string;
  /** True when the 1 km terrain correction was applied. */
  terrainAdjusted: boolean;
}

export interface PointForecast {
  lat: number;
  lon: number;
  district: string | null;
  state: string | null;
  /** Ground height from the 1 km terrain (null while it is unavailable). */
  elevationM: number | null;
  timeMs: number;
  rows: PointRow[];
}

/** Blend two time steps; if one side has no data the other is used. */
export function blendTime(a: number, b: number, mix: number): number {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return a * (1 - mix) + b * mix;
}

/** Meteorological wind: speed in m/s and the direction it blows FROM, in degrees. */
export function windFromUV(u: number, v: number): { speedMs: number; fromDeg: number } {
  const speedMs = Math.hypot(u, v);
  const fromDeg = (270 - (Math.atan2(v, u) * 180) / Math.PI + 360) % 360;
  return { speedMs, fromDeg };
}

const fmt = (v: number, digits = 0): string => (Number.isNaN(v) ? '–' : v.toFixed(digits));
/** A value with its unit, or just a dash when the model does not provide it. */
const withUnit = (v: number, digits: number, unit: string): string => (Number.isNaN(v) ? '–' : `${v.toFixed(digits)} ${unit}`);
const KMH_PER_MS = 3.6;

/** Turns blended raw field values (and the terrain height difference) into display rows. */
export function buildPointRows(values: Record<InspectVar, number>, terrainDz: number | null): PointRow[] {
  const adjust = (mode: TerrainMode, v: number) => (terrainDz === null ? v : applyTerrain(mode, v, terrainDz));
  const adjusted = terrainDz !== null;
  const wind = windFromUV(values.u10, values.v10);
  const rows: PointRow[] = [
    { id: 'temp', label: 'Temperature', text: withUnit(adjust('temperature', values.t2m), 1, '°C'), terrainAdjusted: adjusted },
    { id: 'feels', label: 'Feels like', text: withUnit(adjust('temperature', values.feels), 1, '°C'), terrainAdjusted: adjusted },
    { id: 'humidity', label: 'Humidity', text: withUnit(adjust('humidity', values.rh), 0, '%'), terrainAdjusted: adjusted },
    {
      id: 'wind',
      label: 'Wind',
      text: Number.isNaN(wind.speedMs) ? '–' : `${fmt(wind.speedMs * KMH_PER_MS)} km/h from ${degToCompass(wind.fromDeg)}`,
      terrainAdjusted: false,
    },
    { id: 'gust', label: 'Gusts', text: withUnit(values.gust * KMH_PER_MS, 0, 'km/h'), terrainAdjusted: false },
    { id: 'rain', label: 'Rain', text: withUnit(values.precip, values.precip < 10 ? 1 : 0, 'mm/h'), terrainAdjusted: false },
    { id: 'clouds', label: 'Clouds', text: withUnit(values.cloud, 0, '%'), terrainAdjusted: false },
    { id: 'pressure', label: 'Pressure', text: withUnit(values.msl, 0, 'hPa'), terrainAdjusted: false },
    { id: 'cape', label: 'Thunderstorm energy', text: withUnit(values.cape, 0, 'J/kg'), terrainAdjusted: false },
  ];
  // winds aloft only where the model provides them (not every model has pressure levels)
  for (const [id, label, u, v] of [['wind850', 'Wind 850 hPa', values.u850, values.v850], ['wind500', 'Wind 500 hPa', values.u500, values.v500]] as const) {
    const w = windFromUV(u, v);
    if (!Number.isNaN(w.speedMs)) {
      rows.push({ id, label, text: `${fmt(w.speedMs * KMH_PER_MS)} km/h from ${degToCompass(w.fromDeg)}`, terrainAdjusted: false });
    }
  }
  return rows;
}
