/** Tamil Nadu district microclimate: the published file (pipeline/microclimate.py) and the pure helpers that read it. */

export interface HeatIndicator {
  peakC: number | null;
  peakTime: string | null;
  band: string;
}

export interface RainIndicator {
  start: string | null;
  end: string | null;
  ongoing: boolean;
  peakMmH: number;
  peakTime: string | null;
}

export interface SeaBreezeIndicator {
  likely: boolean;
  from: string | null;
  peakOnshoreMs: number;
}

export interface FloodIndicator {
  band: string;
  peakMm: number | null;
  peakTime: string | null;
}

export interface DistrictSeries {
  tempC: (number | null)[];
  heatIndexC: (number | null)[];
  rhPct: (number | null)[];
  windMs: (number | null)[];
  windFromDeg: (number | null)[];
  precipMmH: (number | null)[];
  rain24Mm: (number | null)[];
}

export interface DistrictMicroclimate {
  name: string;
  lat: number;
  lon: number;
  coastal: boolean;
  series: DistrictSeries;
  indicators: {
    heat: HeatIndicator;
    rain: RainIndicator;
    seaBreeze: SeaBreezeIndicator | null;
    flood: FloodIndicator;
  };
}

export interface MicroclimateData {
  version: number;
  run: string;
  generated: string;
  now: string;
  times: string[];
  note: string;
  districts: DistrictMicroclimate[];
}

/** The values of one district at one time step. */
export interface StepValues {
  tempC: number | null;
  heatIndexC: number | null;
  rhPct: number | null;
  windMs: number | null;
  windFromDeg: number | null;
  precipMmH: number | null;
  rain24Mm: number | null;
}

/** Index of the last step at or before `timeMs` (the first step when the time is earlier than all of them). */
export function stepIndex(times: readonly string[], timeMs: number): number {
  let idx = 0;
  for (let i = 0; i < times.length; i++) {
    if (Date.parse(times[i]) <= timeMs) idx = i;
    else break;
  }
  return idx;
}

export function valuesAt(d: DistrictMicroclimate, index: number): StepValues {
  const s = d.series;
  const at = (arr: (number | null)[] | undefined): number | null => (arr && index >= 0 && index < arr.length ? arr[index] : null);
  return {
    tempC: at(s.tempC),
    heatIndexC: at(s.heatIndexC),
    rhPct: at(s.rhPct),
    windMs: at(s.windMs),
    windFromDeg: at(s.windFromDeg),
    precipMmH: at(s.precipMmH),
    rain24Mm: at(s.rain24Mm),
  };
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** A wind direction (the side it blows from, degrees) as a compass point. */
export function compassPoint(deg: number | null): string {
  if (deg === null || !Number.isFinite(deg)) return '';
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** "14:30 IST" for a time that is today in India, or "9 Oct, 14:30 IST" otherwise. */
export function istLabel(iso: string | null, nowMs: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).format(t);
  const day = (ms: number) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Kolkata' }).format(ms);
  if (day(t) === day(nowMs)) return `${hm} IST`;
  const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(t);
  return `${date}, ${hm} IST`;
}

/** A coarse colour tone for an indicator band, for the card's chips. */
export type Tone = 'ok' | 'watch' | 'warn' | 'alert' | 'none';

export function heatTone(band: string): Tone {
  switch (band) {
    case 'Comfortable': return 'ok';
    case 'Caution': return 'watch';
    case 'Extreme caution': return 'warn';
    case 'Danger':
    case 'Extreme danger': return 'alert';
    default: return 'none';
  }
}

export function floodTone(band: string): Tone {
  switch (band) {
    case 'Low': return 'ok';
    case 'Heavy rain': return 'watch';
    case 'Very heavy rain': return 'warn';
    case 'Extremely heavy rain': return 'alert';
    default: return 'none';
  }
}

/** The districts' names, sorted, for the picker. */
export function districtNames(data: MicroclimateData): string[] {
  return data.districts.map(d => d.name).sort((a, b) => a.localeCompare(b));
}

/** Plain sentence for the rain-timing indicator. */
export function rainSentence(r: RainIndicator, nowMs: number = Date.now()): string {
  if (!r.start) return 'No significant rain (0.5 mm/h or more) in the next 24 h';
  if (r.ongoing) return `Rain now${r.end ? `, until ${istLabel(r.end, nowMs)}` : ', continuing beyond 24 h'}`;
  return `Rain from ${istLabel(r.start, nowMs)}${r.end ? `, until ${istLabel(r.end, nowMs)}` : ''}`;
}

/** Plain sentence for the sea-breeze indicator. */
export function seaBreezeSentence(s: SeaBreezeIndicator | null, nowMs: number = Date.now()): string {
  if (!s) return 'Not a coastal district';
  if (!s.likely && !s.from) return `No sea breeze expected (onshore wind up to ${s.peakOnshoreMs} m/s)`;
  if (!s.likely) return `Weak sea breeze, from ${istLabel(s.from, nowMs)} (up to ${s.peakOnshoreMs} m/s)`;
  return `Sea breeze likely from ${istLabel(s.from, nowMs)}, up to ${s.peakOnshoreMs} m/s`;
}

/** The microclimate fields that can be shown on the map. */
export type MicroMetric = 'feels' | 'temp' | 'rainNow' | 'rain24' | 'wind';

export interface MicroMetricDef {
  id: MicroMetric;
  label: string;
  unit: string;
  /** Display range (low to high), for the labels. */
  min: number;
  max: number;
  /** Value of this metric at one step. */
  value: (v: StepValues) => number | null;
}

export const MICRO_METRICS: readonly MicroMetricDef[] = [
  { id: 'feels', label: 'Feels like', unit: '°C', min: 24, max: 44, value: v => v.heatIndexC },
  { id: 'temp', label: 'Temperature', unit: '°C', min: 20, max: 36, value: v => v.tempC },
  { id: 'rainNow', label: 'Rain now', unit: 'mm/h', min: 0, max: 5, value: v => v.precipMmH },
  { id: 'rain24', label: 'Rain, next 24 h', unit: 'mm', min: 0, max: 100, value: v => v.rain24Mm },
  { id: 'wind', label: 'Wind', unit: 'km/h', min: 0, max: 40, value: v => (v.windMs === null ? null : v.windMs * 3.6) },
];

export function metricById(id: MicroMetric): MicroMetricDef {
  return MICRO_METRICS.find(m => m.id === id) ?? MICRO_METRICS[0];
}

/** The forecast layer (1 km, terrain-adjusted) that shows each microclimate field. */
export const METRIC_LAYER: Record<MicroMetric, string> = { feels: 'feels', temp: 'temp', rainNow: 'rain', rain24: 'rain24', wind: 'wind' };
