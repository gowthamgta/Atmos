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
