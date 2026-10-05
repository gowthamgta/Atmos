/** Declarative registry of the scalar forecast layers. The UI is generated from this list. */

import type { TerrainMode } from './terrain-correction';

export interface ForecastLayerDef {
  id: string;
  label: string;
  icon: string;
  /** Pipeline variable id (see pipeline/config.py). */
  varId: string;
  /** Second component for vector layers: the layer shows hypot(varId, varId2), e.g. wind speed from u and v. */
  varId2?: string;
  /** Unit of the legend and ticks (the field values times `displayScale`). */
  unit: string;
  /** Multiplier from the field's own unit to the displayed unit (m/s to km/h is 3.6). Default 1. */
  displayScale?: number;
  /** Display range mapped onto the palette, in the field's own unit (not the encoding range). */
  min: number;
  max: number;
  /** Evenly spaced palette stops. */
  stops: readonly string[];
  /** Palette position = normalised value ** gamma (use < 1 to stretch low values). */
  gamma: number;
  /** Values below this are transparent (0 = never). */
  clearBelow: number;
  /** Ticks shown under the legend bar, in the displayed unit. */
  ticks: readonly number[];
  /** Fraction of full opacity. */
  opacity: number;
  /** How the 1 km terrain correction applies to this variable (null = shown at model resolution). */
  terrain: TerrainMode | null;
}

/** Dark-theme palettes: the low end sinks into the dark basemap, mid-tones stay saturated and deep,
 *  and only the extremes get bright, so overlays never glare against the dark map. */
const TEMP = ['#2b3a8f', '#256d9b', '#1f9a8a', '#86a936', '#e0a526', '#e0651f', '#b3202f', '#6e1038'];
const HUMIDITY = ['#6b4423', '#9a7b3a', '#5d8a5b', '#2f8a9a', '#2a5bb0', '#4b2d9a'];
const RAIN = ['#1e4fa0', '#1f8fb8', '#27ae75', '#c8b11f', '#e07a1f', '#d62f3a', '#b030c8'];
const CAPE = ['#2a3550', '#1f6f8f', '#2a9d6b', '#c2a31f', '#d9731f', '#c92a3a', '#a03bd0'];
const CLOUD = ['#1c2330', '#3a4558', '#6b778c', '#a3adbd', '#e8edf5'];
const WIND = ['#1b3a6b', '#1f7a9a', '#2aa876', '#b5c22a', '#e0902a', '#d9422a', '#a82f9a'];
const PRESSURE = ['#4a2a8a', '#2a56b0', '#1f8fa8', '#4fae6a', '#c9b92a', '#e0762a', '#b3262f'];
const WATER = ['#2a2018', '#4a5a3a', '#2a7a6a', '#1f6fa8', '#2a46b0', '#6a2fb0'];

export const FORECAST_LAYERS: readonly ForecastLayerDef[] = [
  { id: 'temp', label: 'Temperature', icon: '🌡', varId: 't2m', unit: '°C', min: 18, max: 42, stops: TEMP, gamma: 1, clearBelow: 0, ticks: [20, 25, 30, 35, 40], opacity: 0.85, terrain: 'temperature' },
  { id: 'feels', label: 'Feels like', icon: '🥵', varId: 'feels', unit: '°C', min: 18, max: 48, stops: TEMP, gamma: 1, clearBelow: 0, ticks: [20, 25, 30, 35, 40, 45], opacity: 0.85, terrain: 'temperature' },
  { id: 'humidity', label: 'Humidity', icon: '💧', varId: 'rh', unit: '%', min: 30, max: 100, stops: HUMIDITY, gamma: 1, clearBelow: 0, ticks: [40, 60, 80, 100], opacity: 0.85, terrain: 'humidity' },
  { id: 'wind', label: 'Wind', icon: '🍃', varId: 'u10', varId2: 'v10', unit: 'km/h', displayScale: 3.6, min: 0, max: 20, stops: WIND, gamma: 1, clearBelow: 0, ticks: [10, 20, 30, 40, 50, 60], opacity: 0.8, terrain: null },
  { id: 'wind850', label: 'Wind 850 hPa (~1.5 km)', icon: '🌬', varId: 'u850', varId2: 'v850', unit: 'km/h', displayScale: 3.6, min: 0, max: 25, stops: WIND, gamma: 1, clearBelow: 0, ticks: [20, 40, 60, 80], opacity: 0.8, terrain: null },
  { id: 'wind500', label: 'Wind 500 hPa (~5.5 km)', icon: '✈', varId: 'u500', varId2: 'v500', unit: 'km/h', displayScale: 3.6, min: 0, max: 30, stops: WIND, gamma: 1, clearBelow: 0, ticks: [20, 40, 60, 80, 100], opacity: 0.8, terrain: null },
  { id: 'rain', label: 'Rain', icon: '🌧', varId: 'precip', unit: 'mm/h', min: 0, max: 20, stops: RAIN, gamma: 0.5, clearBelow: 0.1, ticks: [0.5, 2, 5, 10, 20], opacity: 0.9, terrain: null },
  { id: 'clouds', label: 'Clouds', icon: '☁', varId: 'cloud', unit: '%', min: 0, max: 100, stops: CLOUD, gamma: 1, clearBelow: 5, ticks: [25, 50, 75, 100], opacity: 0.8, terrain: null },
  { id: 'cape', label: 'Thunderstorm energy', icon: '⚡', varId: 'cape', unit: 'J/kg', min: 0, max: 4000, stops: CAPE, gamma: 0.7, clearBelow: 100, ticks: [500, 1000, 2000, 3000, 4000], opacity: 0.85, terrain: null },
  { id: 'gust', label: 'Wind gusts', icon: '💨', varId: 'gust', unit: 'km/h', displayScale: 3.6, min: 0, max: 25, stops: WIND, gamma: 1, clearBelow: 0, ticks: [20, 40, 60, 80], opacity: 0.85, terrain: null },
  { id: 'pressure', label: 'Pressure', icon: '⏲', varId: 'msl', unit: 'hPa', min: 1000, max: 1020, stops: PRESSURE, gamma: 1, clearBelow: 0, ticks: [1000, 1005, 1010, 1015, 1020], opacity: 0.8, terrain: null },
  { id: 'tcwv', label: 'Atmospheric moisture', icon: '🌫', varId: 'tcwv', unit: 'kg/m²', min: 20, max: 70, stops: WATER, gamma: 1, clearBelow: 0, ticks: [30, 40, 50, 60, 70], opacity: 0.85, terrain: null },
];

/** True when the model's manifest publishes every variable the layer needs (null manifest: assume yes). */
export function layerAvailable(def: ForecastLayerDef, vars: Record<string, unknown> | null | undefined): boolean {
  if (!vars) return true;
  return def.varId in vars && (def.varId2 === undefined || def.varId2 in vars);
}

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

/** Position 0..1 of a value (in the displayed unit) within the display range after the layer's gamma. */
export function legendPosition(def: ForecastLayerDef, displayedValue: number): number {
  const value = displayedValue / (def.displayScale ?? 1);
  const t = Math.min(Math.max((value - def.min) / (def.max - def.min), 0), 1);
  return Math.pow(t, def.gamma);
}
