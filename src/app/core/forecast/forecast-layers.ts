/** Declarative registry of the scalar forecast layers. The UI is generated from this list. */

import type { TerrainMode } from './terrain-correction';

export interface ForecastLayerDef {
  id: string;
  label: string;
  icon: string;
  /** Pipeline variable id (see pipeline/config.py). */
  varId: string;
  unit: string;
  /** Display range mapped onto the palette (not the encoding range). */
  min: number;
  max: number;
  /** Evenly spaced palette stops. */
  stops: readonly string[];
  /** Palette position = normalised value ** gamma (use < 1 to stretch low values). */
  gamma: number;
  /** Values below this are transparent (0 = never). */
  clearBelow: number;
  /** Ticks shown under the legend bar. */
  ticks: readonly number[];
  /** Fraction of full opacity. */
  opacity: number;
  /** How the 1 km terrain correction applies to this variable (null = shown at model resolution). */
  terrain: TerrainMode | null;
}

const TEMP = ['#2b4c8c', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51', '#b5179e'];
const HUMIDITY = ['#f2e8cf', '#c9d8c5', '#7fb7be', '#3f7cac', '#1d3f72', '#0b1f4d'];
const RAIN = ['#7dd3fc', '#38bdf8', '#22c55e', '#eab308', '#f97316', '#ef4444', '#a855f7'];
const CAPE = ['#64748b', '#06b6d4', '#22c55e', '#eab308', '#f97316', '#ef4444', '#d946ef'];
const CLOUD = ['#334155', '#64748b', '#94a3b8', '#e2e8f0', '#ffffff'];
const PRESSURE = ['#6d28d9', '#2563eb', '#06b6d4', '#a3e635', '#facc15', '#f97316', '#dc2626'];
const WIND = ['#38bdf8', '#22c55e', '#eab308', '#f97316', '#ef4444', '#a855f7'];
const WATER = ['#fdf4e3', '#a7d8de', '#4ba3c3', '#2b6cb0', '#1e3a8a', '#4c1d95'];

export const FORECAST_LAYERS: readonly ForecastLayerDef[] = [
  { id: 'temp', label: 'Temperature', icon: '🌡', varId: 't2m', unit: '°C', min: 18, max: 42, stops: TEMP, gamma: 1, clearBelow: 0, ticks: [20, 25, 30, 35, 40], opacity: 0.85, terrain: 'temperature' },
  { id: 'feels', label: 'Feels like', icon: '🥵', varId: 'feels', unit: '°C', min: 18, max: 48, stops: TEMP, gamma: 1, clearBelow: 0, ticks: [20, 25, 30, 35, 40, 45], opacity: 0.85, terrain: 'temperature' },
  { id: 'humidity', label: 'Humidity', icon: '💧', varId: 'rh', unit: '%', min: 30, max: 100, stops: HUMIDITY, gamma: 1, clearBelow: 0, ticks: [40, 60, 80, 100], opacity: 0.85, terrain: 'humidity' },
  { id: 'rain', label: 'Rain', icon: '🌧', varId: 'precip', unit: 'mm/h', min: 0, max: 20, stops: RAIN, gamma: 0.5, clearBelow: 0.1, ticks: [0.5, 2, 5, 10, 20], opacity: 0.9, terrain: null },
  { id: 'clouds', label: 'Clouds', icon: '☁', varId: 'cloud', unit: '%', min: 0, max: 100, stops: CLOUD, gamma: 1, clearBelow: 5, ticks: [25, 50, 75, 100], opacity: 0.8, terrain: null },
  { id: 'cape', label: 'Thunderstorm energy', icon: '⚡', varId: 'cape', unit: 'J/kg', min: 0, max: 4000, stops: CAPE, gamma: 0.7, clearBelow: 100, ticks: [500, 1000, 2000, 3000, 4000], opacity: 0.85, terrain: null },
  { id: 'gust', label: 'Wind gusts', icon: '💨', varId: 'gust', unit: 'm/s', min: 0, max: 25, stops: WIND, gamma: 1, clearBelow: 0, ticks: [5, 10, 15, 20, 25], opacity: 0.85, terrain: null },
  { id: 'pressure', label: 'Pressure', icon: '⏲', varId: 'msl', unit: 'hPa', min: 1000, max: 1020, stops: PRESSURE, gamma: 1, clearBelow: 0, ticks: [1000, 1005, 1010, 1015, 1020], opacity: 0.8, terrain: null },
  { id: 'tcwv', label: 'Atmospheric moisture', icon: '🌫', varId: 'tcwv', unit: 'kg/m²', min: 20, max: 70, stops: WATER, gamma: 1, clearBelow: 0, ticks: [30, 40, 50, 60, 70], opacity: 0.85, terrain: null },
];

export function forecastLayerById(id: string | null): ForecastLayerDef | null {
  return FORECAST_LAYERS.find(l => l.id === id) ?? null;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 256-entry RGBA lookup table (premultiplied is applied in the shader), linear between stops. */
export function buildPaletteLut(stops: readonly string[], size = 256): Uint8Array {
  const rgb = stops.map(hexToRgb);
  const out = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = (i / (size - 1)) * (rgb.length - 1);
    const k = Math.min(Math.floor(t), rgb.length - 2);
    const f = t - k;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(rgb[k][c] * (1 - f) + rgb[k + 1][c] * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** CSS gradient string matching the palette, for legends. */
export function paletteGradientCss(stops: readonly string[]): string {
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** Position 0..1 of a value within the display range after the layer's gamma. */
export function legendPosition(def: ForecastLayerDef, value: number): number {
  const t = Math.min(Math.max((value - def.min) / (def.max - def.min), 0), 1);
  return Math.pow(t, def.gamma);
}
