import { ForecastGrid, sampleGrid } from './forecast.model';

/**
 * Fields worked out in the browser from the published ones: the rain between two chosen times, and the rain categories that every
 * model agrees on. All fields are row-major Float32Arrays of a grid (row 0 is the north edge), NaN where there is no data.
 */

/** The 0.1 degree grid of all India that both ECMWF IFS and the UK Met Office are published on (see pipeline/config.py). */
export const INDIA_GRID: ForecastGrid = { latMax: 37.5, latMin: 5.0, lonMin: 68.0, lonMax: 97.5, step: 0.1, nx: 296, ny: 326 };

/** The value of the cell nearest a point (categories must not be blended), NaN outside the grid. */
export function nearestValue(values: ArrayLike<number>, grid: ForecastGrid, lat: number, lon: number): number {
  const x = Math.round((lon - grid.lonMin) / grid.step);
  const y = Math.round((grid.latMax - lat) / grid.step);
  return x < 0 || y < 0 || x >= grid.nx || y >= grid.ny ? NaN : values[y * grid.nx + x];
}

/** a * (1 - mix) + b * mix, NaN where either is NaN. */
export function blendFields(a: Float32Array, b: Float32Array, mix: number): Float32Array {
  if (mix <= 0) return a;
  if (mix >= 1) return b;
  const out = new Float32Array(a.length);
  for (let i = 0; i < out.length; i++) out[i] = a[i] * (1 - mix) + b[i] * mix;
  return out;
}

/** The rain that fell between two times, from the running total at each: max(0, end - start); NaN where either is unknown. */
export function differenceField(end: Float32Array, start: Float32Array): Float32Array {
  const out = new Float32Array(end.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, end[i] - start[i]);
  return out;
}

/** The same field on another grid: each cell of `to` is read bilinearly from `from` (NaN outside it). */
export function resampleField(values: Float32Array, from: ForecastGrid, to: ForecastGrid): Float32Array {
  if (from.nx === to.nx && from.ny === to.ny && from.latMax === to.latMax && from.lonMin === to.lonMin && from.step === to.step) return values;
  const out = new Float32Array(to.nx * to.ny);
  for (let j = 0; j < to.ny; j++) {
    const lat = to.latMax - j * to.step;
    for (let i = 0; i < to.nx; i++) out[j * to.nx + i] = sampleGrid(values, from, lat, to.lonMin + i * to.step);
  }
  return out;
}

/** The smallest value across fields in each cell, ignoring NaN (a model with no data there does not vote); NaN where none has data. */
export function minAcross(fields: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(fields[0].length).fill(NaN);
  for (const f of fields) {
    for (let i = 0; i < out.length; i++) {
      const v = f[i];
      if (Number.isNaN(v)) continue;
      if (Number.isNaN(out[i]) || v < out[i]) out[i] = v;
    }
  }
  return out;
}

/** Smooth 5x5 neighbourhood maximum followed by 3x3 average on a grid, preserving NaN where a cell has no valid data. */
function smoothNeighbourhoodMax(field: Float32Array, nx: number, ny: number): Float32Array {
  const max5 = new Float32Array(nx * ny).fill(NaN);
  for (let y = 0; y < ny; y++) {
    const y0 = Math.max(0, y - 2);
    const y1 = Math.min(ny - 1, y + 2);
    for (let x = 0; x < nx; x++) {
      if (Number.isNaN(field[y * nx + x])) continue;
      const x0 = Math.max(0, x - 2);
      const x1 = Math.min(nx - 1, x + 2);
      let best = -Infinity;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * nx;
        for (let xx = x0; xx <= x1; xx++) {
          const v = field[row + xx];
          if (!Number.isNaN(v) && v > best) best = v;
        }
      }
      if (best > -Infinity) max5[y * nx + x] = best;
    }
  }
  const out = new Float32Array(nx * ny).fill(NaN);
  for (let y = 0; y < ny; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(ny - 1, y + 1);
    for (let x = 0; x < nx; x++) {
      if (Number.isNaN(max5[y * nx + x])) continue;
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(nx - 1, x + 1);
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * nx;
        for (let xx = x0; xx <= x1; xx++) {
          const v = max5[row + xx];
          if (!Number.isNaN(v)) {
            sum += v;
            count++;
          }
        }
      }
      if (count > 0) out[y * nx + x] = sum / count;
    }
  }
  return out;
}

/** Maps agreed 24 h rain (mm) onto the continuous 0..3 severity scale (0.5 = notable/moderate-heavy threshold, 1 = heavy, 2 = very heavy, 3 = extreme). */
export function rainMmToSeverity(mm: number): number {
  if (Number.isNaN(mm)) return NaN;
  if (mm <= 0) return 0;
  if (mm < 10) return (mm / 10) * 0.5;
  if (mm < 22) return 0.5 + ((mm - 10) / 12) * 0.5;
  if (mm < 50) return 1.0 + ((mm - 22) / 28) * 1.0;
  if (mm < 100) return 2.0 + ((mm - 50) / 50) * 1.0;
  return 3.0;
}

/** Inverts `rainMmToSeverity`: agreed 24 h rain (mm) from a 0..3 severity value, for the map pin tooltip and place card. */
export function severityToRainMm(sev: number): number {
  if (Number.isNaN(sev)) return NaN;
  if (sev <= 0) return 0;
  if (sev < 0.5) return (sev / 0.5) * 10;
  if (sev < 1.0) return 10 + ((sev - 0.5) / 0.5) * 12;
  if (sev < 2.0) return 22 + (sev - 1.0) * 28;
  if (sev < 3.0) return 50 + (sev - 2.0) * 50;
  return 100;
}

/**
 * Multi-model extreme-rain consensus on `grid` from each model's 24 h rainfall (`rain24` in mm):
 * accounts for ~22 km spatial displacement of rain bands between models and requires at least two models
 * to agree in the neighbourhood (so one outlier never triggers alone, and one smooth AI model never zeroes out the rest).
 */
export function extremeConsensus(rain24Fields: readonly Float32Array[], grid: ForecastGrid = INDIA_GRID): Float32Array {
  const n = grid.nx * grid.ny;
  const out = new Float32Array(n).fill(NaN);
  if (rain24Fields.length < 2) return out;
  const envelopes = rain24Fields.map(f => smoothNeighbourhoodMax(f, grid.nx, grid.ny));
  const scratch = new Float64Array(envelopes.length);
  for (let i = 0; i < n; i++) {
    let count = 0;
    let sum = 0;
    for (let m = 0; m < envelopes.length; m++) {
      const v = envelopes[m][i];
      if (!Number.isNaN(v)) {
        scratch[count++] = v;
        sum += v;
      }
    }
    if (count < 2) continue;
    // Sort the valid model values at this cell in descending order
    const valid = scratch.subarray(0, count).sort();
    const secondHighest = valid[count - 2];
    const mean = sum / count;
    const agreedMm = 0.75 * secondHighest + 0.25 * mean;
    out[i] = rainMmToSeverity(agreedMm);
  }
  return out;
}

/** Packs a field into the layer's image format: R and G hold value = min + (R * 256 + G) / 65535 * (max - min); B = 255 flags "no data". */
export function encodeFieldPixels(values: Float32Array, min: number, max: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const nan = Number.isNaN(v);
    const q = nan ? 65535 : Math.min(65535, Math.max(0, Math.round(((v - min) / (max - min)) * 65535)));
    px[i * 4] = q >> 8;
    px[i * 4 + 1] = q & 255;
    px[i * 4 + 2] = nan ? 255 : 0;
    px[i * 4 + 3] = 255;
  }
  return px;
}

/** The field as an image the colour layer can take (the same format as the published pictures). */
export function encodeFieldBitmap(values: Float32Array, grid: ForecastGrid, min: number, max: number): Promise<ImageBitmap> {
  const data = new ImageData(encodeFieldPixels(values, min, max) as Uint8ClampedArray<ArrayBuffer>, grid.nx, grid.ny);
  return createImageBitmap(data, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}
