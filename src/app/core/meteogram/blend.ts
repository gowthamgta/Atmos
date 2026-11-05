import { ModelSeries, PointSeries } from './point-series';

/**
 * The corrections learned at the airports, as pipeline/blend.py has them: public/data/verification/corrections.json, written by
 * learn_bias.py. (The Kralveth Blend that file also describes is not shown: the owner, 6 Nov 2026, "the blend is not accurate so lets remove it".)
 *
 * A correction is a model's usual error at an airport by hour of the day (UTC) for temperature and humidity, kept only where it lowered the
 * error on days held back from the learning; at a place, the airports' corrections in full within FULL_KM, fading out at FADE_KM.
 */

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
