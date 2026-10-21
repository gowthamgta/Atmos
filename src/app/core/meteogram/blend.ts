import { ModelSeries, PointSeries, SERIES_KEYS, Series } from './point-series';

/**
 * The corrections learned at the airports and the AtmosIQ Blend, as pipeline/blend.py has them (the same file and the same rules, so the
 * Blend in the meteogram is the one that is scored every day): public/data/verification/corrections.json, written by learn_bias.py.
 *
 * A correction is a model's usual error at an airport by hour of the day (UTC) for temperature and humidity, kept only where it lowered the
 * error on days held back from the learning; at a place, the airports' corrections in full within FULL_KM, fading out at FADE_KM. The Blend is
 * the corrected models' weighted mean, each weighted by how small its recent error was; its chance of rain is the weighted share of models
 * with rain, each counted from its own threshold.
 */

export const BLEND_ID = 'blend';
const FULL_KM = 100;
const FADE_KM = 200;

export interface CorrectionsFile {
  updated?: string;
  learned_from?: [string, string];
  airports: Record<string, [number, number]>;
  models: Record<string, {
    api: string;
    map?: boolean;
    temp?: Record<string, number[]>;
    rh?: Record<string, number[]>;
    rain_threshold_mm?: number;
  }>;
  blend?: { temp?: Record<string, number>; rain?: Record<string, number>; rain_cutoff?: number };
  backtest?: { test_days: [string, string]; temp_mae: Record<string, number>; rain_threat: Record<string, number> } | null;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dp = (lat2 - lat1) * rad;
  const dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function distanceWeight(km: number): number {
  if (km <= FULL_KM) return 1;
  if (km >= FADE_KM) return 0;
  return (FADE_KM - km) / (FADE_KM - FULL_KM);
}

/** Each airport's weight at a place (0 for those too far to matter), worked out once per place. */
export function airportWeights(corr: CorrectionsFile, lat: number, lon: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const [icao, [alat, alon]] of Object.entries(corr.airports ?? {})) {
    const w = distanceWeight(haversineKm(lat, lon, alat, alon));
    if (w > 0) out.set(icao, w);
  }
  return out;
}

/** What to take off a model's forecast of temperature or humidity at the place at that hour of the day (UTC). */
export function correctionAt(corr: CorrectionsFile, weights: Map<string, number>, model: string, v: 'temp' | 'rh', hourUtc: number): number {
  const byAirport = corr.models?.[model]?.[v];
  if (!byAirport) return 0;
  let num = 0;
  let den = 0;
  for (const [icao, hours] of Object.entries(byAirport)) {
    const w = weights.get(icao);
    if (!w) continue;
    num += w * (hours[hourUtc] ?? 0);
    den += w;
  }
  return num / Math.max(den, 1);
}

/** The series with each model's temperature, feels-like and humidity corrected at the place (other variables as they are). */
export function applyCorrections(series: PointSeries, corr: CorrectionsFile): PointSeries {
  const weights = airportWeights(corr, series.lat, series.lon);
  if (weights.size === 0) return series;
  const hours = series.times.map(t => new Date(t).getUTCHours());
  const models: Record<string, ModelSeries> = {};
  for (const [id, s] of Object.entries(series.models)) {
    const dt = hours.map(h => correctionAt(corr, weights, id, 'temp', h));
    const drh = hours.map(h => correctionAt(corr, weights, id, 'rh', h));
    if (dt.every(d => d === 0) && drh.every(d => d === 0)) {
      models[id] = s;
      continue;
    }
    models[id] = {
      ...s,
      temp: s.temp.map((v, i) => (v === null ? null : v - dt[i])),
      // feels-like moves with the air temperature it is built on
      feels: s.feels.map((v, i) => (v === null ? null : v - dt[i])),
      humidity: s.humidity.map((v, i) => (v === null ? null : Math.min(100, Math.max(1, v - drh[i])))),
    };
  }
  return { ...series, models };
}

function weightsOf(group: Record<string, number> | undefined, has: (id: string) => boolean): [string, number][] {
  const w = Object.entries(group ?? {}).filter(([id]) => has(id));
  const total = w.reduce((a, [, x]) => a + x, 0);
  return total > 0 ? w.map(([id, x]) => [id, x / total]) : [];
}

/**
 * The Blend at the place: the weighted mean of the (corrected) models at each hour, from the models that have a value then (the weights of the
 * others are shared out), its wind direction from the mean wind vector, and its chance of rain (0-1). Null without blend weights.
 */
export function blendSeries(series: PointSeries, corr: CorrectionsFile): { blend: ModelSeries; rainChance: Series } | null {
  const tempW = corr.blend?.temp;
  const rainW = corr.blend?.rain;
  if (!tempW || Object.keys(tempW).length === 0) return null;
  const n = series.times.length;
  const blend = {} as ModelSeries;
  for (const key of SERIES_KEYS) blend[key] = new Array<number | null>(n).fill(null);
  const rainChance: Series = new Array<number | null>(n).fill(null);
  for (let i = 0; i < n; i++) {
    for (const key of SERIES_KEYS) {
      if (key === 'windDir') continue;
      const group = key === 'rain' ? rainW ?? tempW : tempW;
      const w = weightsOf(group, id => series.models[id]?.[key][i] != null);
      if (w.length === 0) continue;
      blend[key][i] = w.reduce((a, [id, x]) => a + x * (series.models[id][key][i] as number), 0);
    }
    // direction: the mean of the wind vectors (an average of 350 and 10 degrees is north, not south)
    const wd = weightsOf(tempW, id => series.models[id]?.windDir[i] != null && series.models[id]?.wind[i] != null);
    if (wd.length) {
      let u = 0;
      let v = 0;
      for (const [id, x] of wd) {
        const speed = series.models[id].wind[i] as number;
        const dir = ((series.models[id].windDir[i] as number) * Math.PI) / 180;
        u += x * speed * Math.sin(dir);
        v += x * speed * Math.cos(dir);
      }
      blend.windDir[i] = u === 0 && v === 0 ? null : ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
    }
    const rw = weightsOf(rainW, id => series.models[id]?.rain[i] != null);
    if (rw.length) {
      rainChance[i] = rw.reduce((a, [id, x]) => a + ((series.models[id].rain[i] as number) >= (corr.models[id]?.rain_threshold_mm ?? 0.2) ? x : 0), 0);
    }
  }
  return { blend, rainChance };
}

/** The models the Blend needs that are not on the map (and so not in the point forecast's usual request), with Open-Meteo's names. */
export function extraBlendModels(corr: CorrectionsFile | null, mapIds: readonly string[]): { id: string; apiId: string }[] {
  if (!corr?.blend) return [];
  const ids = new Set([...Object.keys(corr.blend.temp ?? {}), ...Object.keys(corr.blend.rain ?? {})]);
  return [...ids].filter(id => !mapIds.includes(id) && corr.models[id]?.api).map(id => ({ id, apiId: corr.models[id].api }));
}
