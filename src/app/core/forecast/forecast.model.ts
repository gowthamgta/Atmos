/** Types and pure helpers for the pre-processed ECMWF IFS fields published by pipeline/run.py. */

/** Where the nwp.yml workflow deploys the data (GitHub Pages, CORS-open). */
export const FORECAST_BASE_URL = 'https://gowthamgta.github.io/Atmos/ecmwf_ifs';

export interface ForecastGrid {
  latMax: number;
  latMin: number;
  lonMin: number;
  lonMax: number;
  /** Grid spacing in degrees (same for latitude and longitude). */
  step: number;
  nx: number;
  ny: number;
}

export interface ForecastVarInfo {
  unit: string;
  /** Value encoded as 0. */
  min: number;
  /** Value encoded as 65535. */
  max: number;
  encoding: 'rg16';
}

export interface ForecastStep {
  /** Forecast hour relative to the model run. */
  h: number;
  /** ISO-8601 valid time (UTC). */
  valid: string;
}

export interface ForecastManifest {
  model: string;
  /** Run id such as 20261004T18Z. */
  run: string;
  grid: ForecastGrid;
  steps: ForecastStep[];
  vars: Record<string, ForecastVarInfo>;
}

/** Two neighbouring steps and the blend weight between them (0 = all A, 1 = all B). */
export interface StepBracket {
  a: number;
  b: number;
  mix: number;
}

/** Index of the two steps surrounding `timeMs` in ascending `validMs`; clamps outside the range. */
export function bracketSteps(validMs: readonly number[], timeMs: number): StepBracket {
  const n = validMs.length;
  if (n === 0) return { a: 0, b: 0, mix: 0 };
  if (timeMs <= validMs[0]) return { a: 0, b: 0, mix: 0 };
  if (timeMs >= validMs[n - 1]) return { a: n - 1, b: n - 1, mix: 0 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (validMs[mid] <= timeMs) lo = mid;
    else hi = mid;
  }
  return { a: lo, b: hi, mix: (timeMs - validMs[lo]) / (validMs[hi] - validMs[lo]) };
}

/** Decodes one pixel of an rg16 field. Returns NaN for the "no data" flag (blue = 255). */
export function decodeRg16(r: number, g: number, b: number, min: number, max: number): number {
  if (b > 127) return NaN;
  return min + ((r * 256 + g) / 65535) * (max - min);
}

/** Web-Mercator Y in 0..1 (0 = north pole side), as used by MapLibre custom layers. */
export function mercatorUnitY(latDeg: number): number {
  const phi = (latDeg * Math.PI) / 180;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI);
}

/** Web-Mercator X in 0..1. */
export function mercatorUnitX(lonDeg: number): number {
  return (lonDeg + 180) / 360;
}

/** Fractional grid position (column, row) of a lon/lat; row 0 is the northern edge. */
export function gridPosition(grid: ForecastGrid, lat: number, lon: number): { x: number; y: number } {
  return { x: (lon - grid.lonMin) / grid.step, y: (grid.latMax - lat) / grid.step };
}

/** Samples a decoded field (row-major, ny rows of nx values) bilinearly, ignoring NaN corners. */
export function sampleGrid(values: ArrayLike<number>, grid: ForecastGrid, lat: number, lon: number): number {
  const { x, y } = gridPosition(grid, lat, lon);
  if (x < 0 || y < 0 || x > grid.nx - 1 || y > grid.ny - 1) return NaN;
  const x0 = Math.min(Math.floor(x), grid.nx - 2);
  const y0 = Math.min(Math.floor(y), grid.ny - 2);
  const fx = x - x0;
  const fy = y - y0;
  let sum = 0;
  let wsum = 0;
  for (let k = 0; k < 4; k++) {
    const ox = k & 1;
    const oy = k >> 1;
    const v = values[(y0 + oy) * grid.nx + x0 + ox];
    if (Number.isNaN(v)) continue;
    const w = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
    sum += v * w;
    wsum += w;
  }
  return wsum > 1e-3 ? sum / wsum : NaN;
}
