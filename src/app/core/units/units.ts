/**
 * Display units, as on windy.com and meteoblue.com: the data is always in °C, m/s, mm and hPa; these functions only change how a
 * value is shown. Wind can be km/h, m/s, mph, knots or Beaufort; temperature °C or °F; rain mm or inches; pressure hPa, inHg or mmHg.
 */
export type TempUnit = 'C' | 'F';
export type WindUnit = 'kmh' | 'ms' | 'mph' | 'kn' | 'bft';
export type RainUnit = 'mm' | 'in';
export type PressureUnit = 'hPa' | 'inHg' | 'mmHg';

export interface Units {
  temp: TempUnit;
  wind: WindUnit;
  rain: RainUnit;
  pressure: PressureUnit;
}

export const METRIC: Units = { temp: 'C', wind: 'kmh', rain: 'mm', pressure: 'hPa' };

export const TEMP_UNITS: readonly TempUnit[] = ['C', 'F'];
export const WIND_UNITS: readonly WindUnit[] = ['kmh', 'ms', 'mph', 'kn', 'bft'];
export const RAIN_UNITS: readonly RainUnit[] = ['mm', 'in'];
export const PRESSURE_UNITS: readonly PressureUnit[] = ['hPa', 'inHg', 'mmHg'];

export const TEMP_LABEL: Record<TempUnit, string> = { C: '°C', F: '°F' };
export const WIND_LABEL: Record<WindUnit, string> = { kmh: 'km/h', ms: 'm/s', mph: 'mph', kn: 'kn', bft: 'bft' };
export const RAIN_LABEL: Record<RainUnit, string> = { mm: 'mm', in: 'in' };
export const PRESSURE_LABEL: Record<PressureUnit, string> = { hPa: 'hPa', inHg: 'inHg', mmHg: 'mmHg' };

const KMH_PER_MS = 3.6;
const MPH_PER_MS = 2.236936;
const KN_PER_MS = 1.943844;
const MM_PER_IN = 25.4;
const INHG_PER_HPA = 0.0295300;
const MMHG_PER_HPA = 0.750062;

/** Beaufort force from a speed in m/s (continuous, so a legend can place its ticks; 0 to 12). */
export function beaufortFromMs(ms: number): number {
  return Math.min(12, Math.pow(Math.max(ms, 0) / 0.836, 2 / 3));
}

export function msFromBeaufort(b: number): number {
  return 0.836 * Math.pow(Math.max(b, 0), 1.5);
}

export function tempFromC(c: number, u: TempUnit): number {
  return u === 'F' ? (c * 9) / 5 + 32 : c;
}
export function tempToC(v: number, u: TempUnit): number {
  return u === 'F' ? ((v - 32) * 5) / 9 : v;
}

export function windFromMs(ms: number, u: WindUnit): number {
  switch (u) {
    case 'kmh': return ms * KMH_PER_MS;
    case 'mph': return ms * MPH_PER_MS;
    case 'kn': return ms * KN_PER_MS;
    case 'bft': return beaufortFromMs(ms);
    default: return ms;
  }
}
export function windToMs(v: number, u: WindUnit): number {
  switch (u) {
    case 'kmh': return v / KMH_PER_MS;
    case 'mph': return v / MPH_PER_MS;
    case 'kn': return v / KN_PER_MS;
    case 'bft': return msFromBeaufort(v);
    default: return v;
  }
}

export function rainFromMm(mm: number, u: RainUnit): number {
  return u === 'in' ? mm / MM_PER_IN : mm;
}
export function rainToMm(v: number, u: RainUnit): number {
  return u === 'in' ? v * MM_PER_IN : v;
}

export function pressureFromHpa(hpa: number, u: PressureUnit): number {
  return u === 'inHg' ? hpa * INHG_PER_HPA : u === 'mmHg' ? hpa * MMHG_PER_HPA : hpa;
}
export function pressureToHpa(v: number, u: PressureUnit): number {
  return u === 'inHg' ? v / INHG_PER_HPA : u === 'mmHg' ? v / MMHG_PER_HPA : v;
}

/** Decimals worth showing for a value of a unit (inches and inHg need more than millimetres and hPa). */
export function digitsFor(kind: 'temp' | 'wind' | 'rain' | 'pressure', u: Units, value?: number): number {
  switch (kind) {
    case 'temp': return 0;
    case 'wind': return u.wind === 'bft' ? 0 : 0;
    case 'rain': return u.rain === 'in' ? (value !== undefined && value >= 1 ? 1 : 2) : value !== undefined && value < 10 ? 1 : 0;
    case 'pressure': return u.pressure === 'inHg' ? 2 : u.pressure === 'mmHg' ? 0 : 0;
  }
}

/** "27°" or "81°" for a temperature in °C. */
export function formatTemp(c: number | null | undefined, u: Units, digits = 0, withUnit = true): string {
  if (c === null || c === undefined || Number.isNaN(c)) return '–';
  return `${tempFromC(c, u.temp).toFixed(digits)}${withUnit ? TEMP_LABEL[u.temp] : '°'}`;
}

/** "12 km/h" for a speed in m/s (Beaufort is shown as "Bft 4"). */
export function formatWind(ms: number | null | undefined, u: Units): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '–';
  const v = windFromMs(ms, u.wind);
  return u.wind === 'bft' ? `Bft ${Math.round(v)}` : `${v.toFixed(u.wind === 'ms' ? 1 : 0)} ${WIND_LABEL[u.wind]}`;
}

/** "4.2 mm" or "0.17 in" for an amount in mm; pass perHour for a rate. */
export function formatRain(mm: number | null | undefined, u: Units, perHour = false): string {
  if (mm === null || mm === undefined || Number.isNaN(mm)) return '–';
  const v = rainFromMm(mm, u.rain);
  return `${v.toFixed(digitsFor('rain', u, v))} ${RAIN_LABEL[u.rain]}${perHour ? '/h' : ''}`;
}

/** "1012 hPa" or "29.88 inHg" for a pressure in hPa. */
export function formatPressure(hpa: number | null | undefined, u: Units): string {
  if (hpa === null || hpa === undefined || Number.isNaN(hpa)) return '–';
  return `${pressureFromHpa(hpa, u.pressure).toFixed(digitsFor('pressure', u))} ${PRESSURE_LABEL[u.pressure]}`;
}

/** The kind of quantity a forecast layer shows, which decides what the units switch does to its legend. */
export type Quantity = 'temp' | 'wind' | 'rain' | 'rainRate' | 'pressure';

const LAYER_QUANTITY: Record<string, Quantity> = {
  temp: 'temp', tmin24: 'temp', tmax24: 'temp', feels: 'temp', dew: 'temp',
  wind: 'wind', gust: 'wind',
  rain: 'rainRate',
  rain24: 'rain', raintot: 'rain',
  pressure: 'pressure',
};

/** The quantity of a layer as it is drawn (a pressure layer aloft shows heights, not hPa, so it is not a pressure). */
export function quantityOf(layerId: string, unit: string): Quantity | null {
  const q = LAYER_QUANTITY[layerId] ?? null;
  if (q === 'pressure' && unit !== 'hPa') return null;
  if (q === 'wind' && unit !== 'km/h') return null;
  return q;
}

/** The units a layer can be switched between, with the labels the legend shows. */
export function unitChoices(q: Quantity): { id: string; label: string }[] {
  switch (q) {
    case 'temp': return TEMP_UNITS.map(id => ({ id, label: TEMP_LABEL[id] }));
    case 'wind': return WIND_UNITS.map(id => ({ id, label: WIND_LABEL[id] }));
    case 'rain': return RAIN_UNITS.map(id => ({ id, label: RAIN_LABEL[id] }));
    case 'rainRate': return RAIN_UNITS.map(id => ({ id, label: `${RAIN_LABEL[id]}/h` }));
    case 'pressure': return PRESSURE_UNITS.map(id => ({ id, label: PRESSURE_LABEL[id] }));
  }
}

/** The legend's unit label and value converters for a layer under the chosen units (base = the unit the layer is drawn in). */
export function legendConversion(q: Quantity, u: Units): { label: string; from: (base: number) => number; to: (shown: number) => number; integer: boolean } {
  switch (q) {
    case 'temp': return { label: TEMP_LABEL[u.temp], from: v => tempFromC(v, u.temp), to: v => tempToC(v, u.temp), integer: false };
    case 'wind': return { label: WIND_LABEL[u.wind], from: kmh => windFromMs(kmh / KMH_PER_MS, u.wind), to: v => windToMs(v, u.wind) * KMH_PER_MS, integer: u.wind === 'bft' };
    case 'rain': return { label: RAIN_LABEL[u.rain], from: v => rainFromMm(v, u.rain), to: v => rainToMm(v, u.rain), integer: false };
    case 'rainRate': return { label: `${RAIN_LABEL[u.rain]}/h`, from: v => rainFromMm(v, u.rain), to: v => rainToMm(v, u.rain), integer: false };
    case 'pressure': return { label: PRESSURE_LABEL[u.pressure], from: v => pressureFromHpa(v, u.pressure), to: v => pressureToHpa(v, u.pressure), integer: false };
  }
}

/** Round tick values inside [lo, hi] (about `count` of them), on a 1, 2 or 5 step. */
export function niceTicks(lo: number, hi: number, count = 6, integer = false): number[] {
  if (!(hi > lo)) return [];
  const raw = (hi - lo) / count;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const frac = raw / pow;
  let step = (frac < 1.5 ? 1 : frac < 3.5 ? 2 : frac < 7.5 ? 5 : 10) * pow;
  if (integer) step = Math.max(1, Math.round(step));
  const out: number[] = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k++) out.push(Math.round(k * step * 1e9) / 1e9 || 0); // from whole multiples (and never -0), so no 0.6000000000000001
  return out;
}
