/** Declarative registry of the scalar forecast layers. The menu and legend are generated from this list. */

import type { TerrainMode } from './terrain-correction';

/** Altitude: the ground (10 m / 2 m fields) or a pressure level in hPa. */
export type Level = 'surface' | 925 | 850 | 700 | 500 | 300 | 200;
export const PRESSURE_LEVELS = [925, 850, 700, 500, 300, 200] as const;
export const ALL_LEVELS: readonly Level[] = ['surface', ...PRESSURE_LEVELS];

/** Roughly how high each pressure level is above sea level, for the altitude menu. */
export const LEVEL_KM: Record<number, number> = { 925: 0.8, 850: 1.5, 700: 3.0, 500: 5.6, 300: 9.2, 200: 12.0 };

export function levelLabel(level: Level): string {
  return level === 'surface' ? 'Surface' : `${level} hPa`;
}

export function levelHeightLabel(level: Level): string {
  return level === 'surface' ? 'at the ground' : `about ${LEVEL_KM[level]} km up`;
}

export type LayerGroup = 'Temperature' | 'Wind' | 'Rain and humidity' | 'Rain chance (24 h)' | 'Visibility' | 'Pressure and storms';

/** The part of a layer that changes with altitude. */
export interface LevelSpec {
  varId: string;
  varId2?: string;
  unit?: string;
  displayScale?: number;
  min: number;
  max: number;
  ticks: readonly number[];
  label?: string;
}

export interface ForecastLayerDef {
  id: string;
  label: string;
  icon: string;
  group: LayerGroup;
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
  /** How the 1 km terrain downscaling applies to this variable (null: smooth interpolation of the model field only). */
  terrain: TerrainMode | null;
  /** Pressure-level layers: about how high the level is (m). Where the ground is higher, the level is underground. */
  levelHeightM?: number;
  /** Present when the layer can be shown at a pressure level: what changes there. */
  atLevel?: (level: number) => LevelSpec;
}

/** Dark-theme palettes: the low end sinks into the dark basemap, mid-tones stay saturated and deep,
 *  and only the extremes get bright, so overlays never glare against the dark map. */
const TEMP = ['#2b3a8f', '#256d9b', '#1f9a8a', '#86a936', '#e0a526', '#e0651f', '#b3202f', '#6e1038'];
const HUMIDITY = ['#6b4423', '#9a7b3a', '#5d8a5b', '#2f8a9a', '#2a5bb0', '#4b2d9a'];
const RAIN = ['#1e4fa0', '#1f8fb8', '#27ae75', '#c8b11f', '#e07a1f', '#d62f3a', '#b030c8'];
const CAPE = ['#2a3550', '#1f6f8f', '#2a9d6b', '#c2a31f', '#d9731f', '#c92a3a', '#a03bd0'];
const WIND = ['#1b3a6b', '#1f7a9a', '#2aa876', '#b5c22a', '#e0902a', '#d9422a', '#a82f9a'];
const PRESSURE = ['#4a2a8a', '#2a56b0', '#1f8fa8', '#4fae6a', '#c9b92a', '#e0762a', '#b3262f'];
const WATER = ['#2a2018', '#4a5a3a', '#2a7a6a', '#1f6fa8', '#2a46b0', '#6a2fb0'];
const DEW = ['#3a2f5c', '#2a5aa0', '#1f8a8f', '#5aa84a', '#d4b02a', '#d9622a'];
const VISIBILITY = ['#a02c4a', '#d17a22', '#d4c02a', '#3fae6a', '#1f6f8f'];
const PROB = ['#1c2330', '#2a4a8a', '#2a9d8f', '#e0b02a', '#e0652a', '#b3262f', '#8a1f9a'];
// lifted index: negative (unstable, storms possible) is the warm end, positive (stable) the cool end
const STABILITY = ['#b3262f', '#e0652a', '#e0b02a', '#4fae6a', '#1f8fa8', '#2a56b0'];
const INHIBITION = ['#1c2330', '#2a4a8a', '#1f8fa8', '#4fae6a', '#e0b02a', '#e0652a'];

// --- what changes with altitude -------------------------------------------------------------------------------
// Display ranges are chosen for the tropics (this domain), wide enough to cover every season.
const TEMP_RANGE: Record<number, [number, number, number[]]> = {
  925: [18, 34, [20, 24, 28, 32]],
  850: [12, 26, [14, 18, 22, 26]],
  700: [2, 16, [4, 8, 12, 16]],
  500: [-14, 0, [-12, -8, -4, 0]],
  300: [-40, -24, [-38, -34, -30, -26]],
  200: [-60, -44, [-58, -54, -50, -46]],
};
// maximum wind speed shown (m/s), with ticks in km/h
const WIND_RANGE: Record<number, [number, number[]]> = {
  925: [20, [20, 40, 60]],
  850: [25, [20, 40, 60, 80]],
  700: [30, [20, 40, 60, 80, 100]],
  500: [40, [30, 60, 90, 120]],
  300: [60, [50, 100, 150, 200]],
  200: [70, [50, 100, 150, 200, 250]],
};
// geopotential height of the pressure surface (m)
const HEIGHT_RANGE: Record<number, [number, number, number[]]> = {
  925: [700, 840, [720, 760, 800, 840]],
  850: [1440, 1600, [1450, 1500, 1550, 1600]],
  700: [3050, 3230, [3080, 3120, 3160, 3200]],
  500: [5800, 5960, [5820, 5870, 5920, 5960]],
  300: [9600, 9800, [9640, 9700, 9760]],
  200: [12350, 12550, [12400, 12450, 12500]],
};

export const FORECAST_LAYERS: readonly ForecastLayerDef[] = [
  {
    id: 'temp', label: 'Temperature', icon: '🌡', group: 'Temperature', varId: 't2m', unit: '°C', min: 18, max: 42, stops: TEMP, gamma: 1,
    clearBelow: 0, ticks: [20, 25, 30, 35, 40], opacity: 0.85, terrain: 'temperature',
    atLevel: l => ({ varId: `t${l}`, min: TEMP_RANGE[l][0], max: TEMP_RANGE[l][1], ticks: TEMP_RANGE[l][2] }),
  },
  { id: 'tmin24', label: 'Lowest, next 24 h', icon: '🥶', group: 'Temperature', varId: 'tmin24', unit: '°C', min: 18, max: 42, stops: TEMP, gamma: 1, clearBelow: 0, ticks: [20, 25, 30, 35, 40], opacity: 0.85, terrain: 'temperature' },
  { id: 'tmax24', label: 'Highest, next 24 h', icon: '🔥', group: 'Temperature', varId: 'tmax24', unit: '°C', min: 18, max: 42, stops: TEMP, gamma: 1, clearBelow: 0, ticks: [20, 25, 30, 35, 40], opacity: 0.85, terrain: 'temperature' },
  { id: 'feels', label: 'Feels like', icon: '🥵', group: 'Temperature', varId: 'feels', unit: '°C', min: 18, max: 48, stops: TEMP, gamma: 1, clearBelow: 0, ticks: [20, 25, 30, 35, 40, 45], opacity: 0.85, terrain: 'temperature' },
  { id: 'dew', label: 'Dew point', icon: '💦', group: 'Temperature', varId: 'dew', unit: '°C', min: 10, max: 28, stops: DEW, gamma: 1, clearBelow: 0, ticks: [12, 16, 20, 24, 28], opacity: 0.85, terrain: 'dewpoint' },
  {
    id: 'wind', label: 'Wind', icon: '🍃', group: 'Wind', varId: 'u10', varId2: 'v10', unit: 'km/h', displayScale: 3.6, min: 0, max: 20, stops: WIND,
    gamma: 1, clearBelow: 0, ticks: [10, 20, 30, 40, 50, 60], opacity: 0.8, terrain: 'wind',
    atLevel: l => ({ varId: `u${l}`, varId2: `v${l}`, min: 0, max: WIND_RANGE[l][0], ticks: WIND_RANGE[l][1] }),
  },
  { id: 'gust', label: 'Wind gusts', icon: '💨', group: 'Wind', varId: 'gust', unit: 'km/h', displayScale: 3.6, min: 0, max: 25, stops: WIND, gamma: 1, clearBelow: 0, ticks: [20, 40, 60, 80], opacity: 0.85, terrain: 'wind' },
  {
    id: 'humidity', label: 'Humidity', icon: '💧', group: 'Rain and humidity', varId: 'rh', unit: '%', min: 30, max: 100, stops: HUMIDITY, gamma: 1,
    clearBelow: 0, ticks: [40, 60, 80, 100], opacity: 0.85, terrain: 'humidity',
    atLevel: l => ({ varId: `rh${l}`, min: 0, max: 100, ticks: [20, 40, 60, 80, 100] }),
  },
  { id: 'rain', label: 'Rain', icon: '🌧', group: 'Rain and humidity', varId: 'precip', unit: 'mm/h', min: 0, max: 20, stops: RAIN, gamma: 0.5, clearBelow: 0.1, ticks: [0.5, 2, 5, 10, 20], opacity: 0.9, terrain: 'rain' },
  { id: 'rain24', label: 'Rain, next 24 h', icon: '🌊', group: 'Rain and humidity', varId: 'rain24', unit: 'mm', min: 0, max: 150, stops: RAIN, gamma: 0.5, clearBelow: 1, ticks: [5, 10, 25, 50, 100, 150], opacity: 0.9, terrain: 'rain' },
  { id: 'tcwv', label: 'Atmospheric moisture', icon: '🌫', group: 'Rain and humidity', varId: 'tcwv', unit: 'kg/m²', min: 20, max: 70, stops: WATER, gamma: 1, clearBelow: 0, ticks: [30, 40, 50, 60, 70], opacity: 0.85, terrain: 'column' },
  { id: 'px0', label: 'Chance of rain', icon: '🌦', group: 'Rain chance (24 h)', varId: 'px0', unit: '% chance of 0.1 mm or more', min: 0, max: 100, stops: PROB, gamma: 1, clearBelow: 5, ticks: [10, 25, 50, 75, 100], opacity: 0.88, terrain: null },
  { id: 'xr', label: 'Extreme rain probability', icon: '⚠', group: 'Rain chance (24 h)', varId: 'xr', unit: '% chance of an extreme rain day', min: 0, max: 100, stops: PROB, gamma: 0.9, clearBelow: 3, ticks: [10, 25, 50, 75, 95], opacity: 0.9, terrain: null },
  { id: 'vis', label: 'Visibility', icon: '🔭', group: 'Visibility', varId: 'vis', unit: 'km', min: 0, max: 20, stops: VISIBILITY, gamma: 0.6, clearBelow: 0, ticks: [1, 2, 5, 10, 20], opacity: 0.8, terrain: null },
  {
    id: 'pressure', label: 'Pressure', icon: '⏲', group: 'Pressure and storms', varId: 'msl', unit: 'hPa', min: 1000, max: 1020, stops: PRESSURE, gamma: 1,
    clearBelow: 0, ticks: [1000, 1005, 1010, 1015, 1020], opacity: 0.8, terrain: null,
    atLevel: l => ({ varId: `gh${l}`, unit: 'm', min: HEIGHT_RANGE[l][0], max: HEIGHT_RANGE[l][1], ticks: HEIGHT_RANGE[l][2], label: 'Height of the surface' }),
  },
  { id: 'li', label: 'Lifted index', icon: '🎈', group: 'Pressure and storms', varId: 'li', unit: '°C', min: -8, max: 8, stops: STABILITY, gamma: 1, clearBelow: 0, ticks: [-6, -3, 0, 3, 6], opacity: 0.85, terrain: null },
  { id: 'cin', label: 'Convective inhibition', icon: '🧊', group: 'Pressure and storms', varId: 'cin', unit: 'J/kg', min: 0, max: 300, stops: INHIBITION, gamma: 0.7, clearBelow: 5, ticks: [25, 50, 100, 200, 300], opacity: 0.85, terrain: null },
  { id: 'cape', label: 'Thunderstorm energy', icon: '⚡', group: 'Pressure and storms', varId: 'cape', unit: 'J/kg', min: 0, max: 4000, stops: CAPE, gamma: 0.7, clearBelow: 100, ticks: [500, 1000, 2000, 3000, 4000], opacity: 0.85, terrain: null },
];

export const LAYER_GROUPS: readonly LayerGroup[] = ['Temperature', 'Wind', 'Rain and humidity', 'Rain chance (24 h)', 'Visibility', 'Pressure and storms'];

/** True when the layer can be shown at pressure levels. */
export function supportsLevels(def: ForecastLayerDef | null): boolean {
  return !!def?.atLevel;
}

/** The layer as drawn at an altitude: same palette, but the variables, range, ticks and label of that level. */
export function resolveLayer(def: ForecastLayerDef, level: Level): ForecastLayerDef {
  if (level === 'surface' || !def.atLevel) return def;
  const spec = def.atLevel(level);
  return {
    ...def,
    ...spec,
    varId2: spec.varId2,                // a scalar level layer must not inherit the surface layer's second component
    label: `${spec.label ?? def.label} · ${level} hPa`,
    terrain: null,                      // the 1 km terrain correction only applies to the near-surface fields
    levelHeightM: LEVEL_KM[level] * 1000, // where the ground reaches above the level it is shown faded
    clearBelow: 0,
  };
}

/** True when the model's manifest publishes every variable the layer needs (null manifest: assume yes). */
export function layerAvailable(def: ForecastLayerDef, vars: Record<string, unknown> | null | undefined): boolean {
  if (!vars) return true;
  return def.varId in vars && (def.varId2 === undefined || def.varId2 in vars);
}

/** True when the layer, drawn at this altitude, has its data in the model. */
export function layerAvailableAt(def: ForecastLayerDef, level: Level, vars: Record<string, unknown> | null | undefined): boolean {
  if (level !== 'surface' && !def.atLevel) return false;
  return layerAvailable(resolveLayer(def, level), vars);
}

/** Altitudes the model has any data for (the surface is always offered). */
export function availableLevels(vars: Record<string, unknown> | null | undefined): Level[] {
  if (!vars) return [...ALL_LEVELS];
  return ALL_LEVELS.filter(l => l === 'surface' || `t${l}` in vars || `u${l}` in vars || `gh${l}` in vars);
}

/** Which two variables the wind animation follows at an altitude. */
export function windVars(level: Level): [string, string] {
  return level === 'surface' ? ['u10', 'v10'] : [`u${level}`, `v${level}`];
}

export interface ContourSpec {
  varId: string;
  /** Spacing between lines, in the variable's unit (hPa at the surface, metres of height aloft). */
  step: number;
  unit: string;
}

const CONTOUR_STEP: Record<number, number> = { 925: 5, 850: 10, 700: 10, 500: 20, 300: 20, 200: 20 };

/** Contour lines: isobars of sea-level pressure at the surface, height lines of the pressure surface aloft. */
export function contourSpec(level: Level): ContourSpec {
  return level === 'surface'
    ? { varId: 'msl', step: 2, unit: 'hPa' }
    : { varId: `gh${level}`, step: CONTOUR_STEP[level], unit: 'm' };
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
