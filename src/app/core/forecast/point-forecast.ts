import { degToCompass } from '../domain/models/microclimate.model';
import { TerrainMode, applyTerrain } from './terrain-correction';

/** Variables read for a clicked point (pipeline ids). */
export const INSPECT_VARS = ['t2m', 'feels', 'rh', 'u10', 'v10', 'gust', 'precip', 'cloud', 'msl', 'cape'] as const;
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
const KMH_PER_MS = 3.6;

/** Turns blended raw field values (and the terrain height difference) into display rows. */
export function buildPointRows(values: Record<InspectVar, number>, terrainDz: number | null): PointRow[] {
  const adjust = (mode: TerrainMode, v: number) => (terrainDz === null ? v : applyTerrain(mode, v, terrainDz));
  const adjusted = terrainDz !== null;
  const wind = windFromUV(values.u10, values.v10);
  const rows: PointRow[] = [
    { id: 'temp', label: 'Temperature', text: `${fmt(adjust('temperature', values.t2m), 1)} °C`, terrainAdjusted: adjusted },
    { id: 'feels', label: 'Feels like', text: `${fmt(adjust('temperature', values.feels), 1)} °C`, terrainAdjusted: adjusted },
    { id: 'humidity', label: 'Humidity', text: `${fmt(adjust('humidity', values.rh))} %`, terrainAdjusted: adjusted },
    {
      id: 'wind',
      label: 'Wind',
      text: Number.isNaN(wind.speedMs) ? '–' : `${fmt(wind.speedMs * KMH_PER_MS)} km/h from ${degToCompass(wind.fromDeg)}`,
      terrainAdjusted: false,
    },
    { id: 'gust', label: 'Gusts', text: `${fmt(values.gust * KMH_PER_MS)} km/h`, terrainAdjusted: false },
    { id: 'rain', label: 'Rain', text: `${fmt(values.precip, values.precip < 10 ? 1 : 0)} mm/h`, terrainAdjusted: false },
    { id: 'clouds', label: 'Clouds', text: `${fmt(values.cloud)} %`, terrainAdjusted: false },
    { id: 'pressure', label: 'Pressure', text: `${fmt(values.msl)} hPa`, terrainAdjusted: false },
    { id: 'cape', label: 'Thunderstorm energy', text: `${fmt(values.cape)} J/kg`, terrainAdjusted: false },
  ];
  return rows;
}
