/**
 * The hourly forecast at one point for every model, from Open-Meteo's forecast API (one request answers for all five models). This is the data
 * of the meteogram. The map's own pictures are not used here: reading a week of hours for five models from them would take thousands of pictures.
 * Everything below is plain functions, so it is tested without the network.
 */

/** Open-Meteo's name of each hourly variable we read, and the key it has in a model's series. */
export const API_VARS = {
  temp: 'temperature_2m',
  feels: 'apparent_temperature',
  humidity: 'relative_humidity_2m',
  rain: 'precipitation',
  wind: 'wind_speed_10m',
  windDir: 'wind_direction_10m',
  gust: 'wind_gusts_10m',
  pressure: 'pressure_msl',
  cloud: 'cloud_cover',
} as const;

export type SeriesKey = keyof typeof API_VARS;
export const SERIES_KEYS = Object.keys(API_VARS) as SeriesKey[];

/** One variable over the hours of the series; null where the model has no value (a model that does not provide it, or whose run has ended). */
export type Series = (number | null)[];
export type ModelSeries = Record<SeriesKey, Series>;

export interface PointSeries {
  /** The point asked for. */
  lat: number;
  lon: number;
  /** The height of the ground there, from Open-Meteo's terrain model (temperatures are already moved to it). */
  elevationM: number | null;
  /** Hourly times, epoch ms, ascending. */
  times: number[];
  /** By our model id. */
  models: Record<string, ModelSeries>;
}

export interface ApiModel {
  /** Our id (ecmwf_ifs...). */
  id: string;
  /** Open-Meteo's name for it. */
  apiId: string;
}

export const API_BASE = 'https://api.open-meteo.com/v1/forecast';
const HOUR_MS = 3_600_000;

/** The address of one request: all models, all variables, the day before today and `forecastDays` ahead, speeds in m/s. */
export function seriesUrl(lat: number, lon: number, models: readonly ApiModel[], pastDays = 1, forecastDays = 10): string {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: Object.values(API_VARS).join(','),
    models: models.map(m => m.apiId).join(','),
    timeformat: 'unixtime',
    wind_speed_unit: 'ms',
    past_days: String(pastDays),
    forecast_days: String(forecastDays),
  });
  return `${API_BASE}?${q.toString().replace(/%2C/g, ',')}`;
}

function numbers(value: unknown, length: number): Series {
  const out: Series = new Array<number | null>(length).fill(null);
  if (!Array.isArray(value)) return out;
  for (let i = 0; i < length; i++) {
    const v = value[i];
    out[i] = typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return out;
}

/** Reads the API's answer. Null when it is not an answer for these models (an error object, no times). */
export function parsePointSeries(json: unknown, models: readonly ApiModel[], lat: number, lon: number): PointSeries | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as { hourly?: Record<string, unknown>; elevation?: unknown };
  const hourly = j.hourly;
  const time = hourly?.['time'];
  if (!hourly || !Array.isArray(time) || time.length === 0) return null;
  const times = time.map(t => Number(t) * 1000);
  if (times.some(t => !Number.isFinite(t))) return null;
  const out: Record<string, ModelSeries> = {};
  for (const m of models) {
    const series = {} as ModelSeries;
    for (const key of SERIES_KEYS) {
      // with several models every key carries the model's name; with one model the API may leave it off
      series[key] = numbers(hourly[`${API_VARS[key]}_${m.apiId}`] ?? (models.length === 1 ? hourly[API_VARS[key]] : undefined), times.length);
    }
    out[m.id] = series;
  }
  const elevation = typeof j.elevation === 'number' && Number.isFinite(j.elevation) ? j.elevation : null;
  return { lat, lon, elevationM: elevation, times, models: out };
}

/** Index of the hour at or nearest to a time (clamped to the series). */
export function indexAt(times: readonly number[], ms: number): number {
  const n = times.length;
  if (n === 0) return -1;
  if (ms <= times[0]) return 0;
  if (ms >= times[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= ms) lo = mid;
    else hi = mid;
  }
  return ms - times[lo] <= times[hi] - ms ? lo : hi;
}

/** The last hour a model has a value for a variable (-1 when it has none): where a short-range model's line ends. */
export function lastIndex(series: Series): number {
  for (let i = series.length - 1; i >= 0; i--) if (series[i] !== null) return i;
  return -1;
}

/** The first hour a model has a value for a variable (-1 when it has none). */
export function firstIndex(series: Series): number {
  for (let i = 0; i < series.length; i++) if (series[i] !== null) return i;
  return -1;
}

/**
 * Sum of the values from an hour for `hours` hours; null when none of them is known. With `wholeWindow` it is null too when the series ends or has a
 * gap inside the window (rain over the next 24 h means nothing for a model whose run stops after 10 of them).
 */
export function sumFrom(series: Series, from: number, hours: number, wholeWindow = false): number | null {
  let sum = 0;
  let seen = 0;
  const start = Math.max(from, 0);
  for (let i = start; i < start + hours; i++) {
    const v = i < series.length ? series[i] : null;
    if (v !== null) {
      sum += v;
      seen++;
    }
  }
  if (seen === 0 || (wholeWindow && seen < hours)) return null;
  return sum;
}

/**
 * A running total over the hours from `from` to `to`, starting at the first hour a value is known. An hour in the middle without a value carries
 * the total on (so the line does not break); after the model's last hour there is no total (the line ends where the model does).
 */
export function cumulative(series: Series, from: number, to: number): Series {
  const out: Series = [];
  const last = lastIndex(series);
  let total = 0;
  let started = false;
  for (let i = from; i <= to && i < series.length; i++) {
    const v = series[i];
    if (v !== null) {
      total += v;
      started = true;
    }
    out.push(started && i <= last ? total : null);
  }
  return out;
}

/** The smallest and largest of a set of values (nulls left out); null when there are none. */
export function extent(values: readonly (number | null)[]): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v === null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/** How far apart the models are at one time: the spread of their values (largest minus smallest). Null when fewer than two have a value. */
export function spreadOf(values: readonly (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length >= 2 ? Math.max(...known) - Math.min(...known) : null;
}

/** The hourly times of a window: from `startMs` for `hours` hours, as the indexes into the series. */
export function windowIndexes(times: readonly number[], startMs: number, endMs: number): { from: number; to: number } | null {
  if (times.length === 0) return null;
  let from = times.findIndex(t => t >= startMs);
  if (from < 0) return null;
  let to = from;
  while (to + 1 < times.length && times[to + 1] <= endMs) to++;
  from = Math.max(from, 0);
  return to >= from ? { from, to } : null;
}

/** Whole hours between two series times (they are hourly, so this is the number of steps). */
export function hoursBetween(a: number, b: number): number {
  return Math.round((b - a) / HOUR_MS);
}
