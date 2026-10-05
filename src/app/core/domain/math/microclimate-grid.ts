import {
  MicroclimateBounds,
  TERRAIN_FALLBACK_METERS,
  rasterRowLatitude
} from '../models/microclimate.model';

// ── Terrain downscaling rules ─────────────────────────────────────────────
// Shared by the per-point samplers (MicroclimateService) and the raster builder below so the
// map, the click inspector and the city badges can never disagree.

/** Standard environmental lapse rate: -6.5 °C per 1,000 m. */
export const LAPSE_RATE_C_PER_M = 0.0065;
/** Relative humidity gain per metre of terrain above the model surface (cooler air holds less vapour). */
export const HUMIDITY_PER_M = 0.022;
/** Height above the model surface at which orographic effects reach their maximum. */
export const OROGRAPHIC_SCALE_M = 1200;

/** 0..1 strength of terrain effects for a point `elevDiff` metres above the model's own surface. */
export function orographicFraction(elevDiff: number): number {
  return Math.min(1.0, Math.max(0, elevDiff) / OROGRAPHIC_SCALE_M);
}

/** `tempSeaLevel` is the model 2 m temperature reduced to sea level (T + lapse × model elevation). */
export function downscaleTemperature(tempSeaLevel: number, elevation: number): number {
  return Math.round((tempSeaLevel - elevation * LAPSE_RATE_C_PER_M) * 10) / 10;
}

export function downscaleHumidity(baseHumidity: number, elevDiff: number): number {
  return Math.round(Math.max(15, Math.min(98, baseHumidity + elevDiff * HUMIDITY_PER_M)));
}

export function downscaleRain(baseRain: number, orographicFrac: number): number {
  return Math.round(Math.max(0, baseRain * (1.0 + 0.40 * orographicFrac)) * 10) / 10;
}

export function downscaleCape(baseCape: number, orographicFrac: number): number {
  return Math.round(Math.max(0, baseCape * (1.0 - 0.22 * orographicFrac)));
}

/** Venturi-style ridge speed-up multiplier. */
export function windSpeedup(orographicFrac: number): number {
  return 1.0 + 0.35 * orographicFrac;
}

// ── Raster builder ────────────────────────────────────────────────────────

/** ECMWF node fields (row-major, `nLat` x `nLon`) that the 500 m rasters are interpolated from. */
export interface MicroclimateNodeFields {
  /** 2 m temperature reduced to sea level, so interpolation is independent of each node's own height */
  readonly tempsSeaLevel: Float32Array;
  readonly hums: Float32Array;
  readonly rain24h: Float32Array;
  readonly cape: Float32Array;
  /** Elevation of the surface each node's values refer to (metres) */
  readonly nodeElev: Float32Array;
  readonly nLat: number;
  readonly nLon: number;
  readonly nodeMinLat: number;
  readonly nodeMinLon: number;
  readonly nodeStep: number;
}

export interface MicroclimateGridInput extends MicroclimateNodeFields {
  readonly bounds: MicroclimateBounds;
  readonly width: number;
  readonly height: number;
}

export interface MicroclimateBaseGrids {
  readonly temp: Float32Array;
  readonly hum: Float32Array;
  readonly rain: Float32Array;
  readonly cape: Float32Array;
}

/**
 * Catmull-Rom node indices and weights at one coordinate, using the same clamping as
 * MicroclimateService.interpolateNativeEcmwf().
 */
function buildStencil(
  coord: number, min: number, step: number, n: number,
  idx: Int32Array, w: Float64Array, o: number
): void {
  const clamped = Math.max(0, Math.min(n - 1.0001, (coord - min) / step));
  const i1 = Math.floor(clamped);
  const t = clamped - i1;
  const t2 = t * t;
  const t3 = t2 * t;
  idx[o] = Math.max(0, i1 - 1);
  idx[o + 1] = i1;
  idx[o + 2] = Math.min(n - 1, i1 + 1);
  idx[o + 3] = Math.min(n - 1, i1 + 2);
  w[o] = -0.5 * t3 + t2 - 0.5 * t;
  w[o + 1] = 1.5 * t3 - 2.5 * t2 + 1.0;
  w[o + 2] = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
  w[o + 3] = 0.5 * t3 - 0.5 * t2;
}

function applyStencil(
  grid: Float32Array, nLon: number,
  rowIdx: Int32Array, rowW: Float64Array,
  colIdx: Int32Array, colW: Float64Array, co: number
): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const base = rowIdx[i] * nLon;
    sum += rowW[i] * (
      colW[co] * grid[base + colIdx[co]] +
      colW[co + 1] * grid[base + colIdx[co + 1]] +
      colW[co + 2] * grid[base + colIdx[co + 2]] +
      colW[co + 3] * grid[base + colIdx[co + 3]]
    );
  }
  return sum;
}

/**
 * Builds the four 500 m base fields in one pass. Produces the same values as
 * MicroclimateService.sampleSpatialWeather / sampleSpatialRain / sampleSpatialCape, but shares the
 * bicubic stencil across fields instead of recomputing it per cell.
 * Pure, so it runs both in the microclimate web worker and on the main thread as a fallback.
 *
 * `elevation` is the terrain raster (metres) with the same geometry as the output; without it a
 * flat TERRAIN_FALLBACK_METERS surface is assumed.
 */
export function buildMicroclimateBaseGrids(
  input: MicroclimateGridInput,
  elevation: ArrayLike<number> | null
): MicroclimateBaseGrids {
  const { bounds, width: w, height: h, nLat, nLon, nodeMinLat, nodeMinLon, nodeStep } = input;
  const total = w * h;
  const lonSpan = bounds.maxLon - bounds.minLon;

  const temp = new Float32Array(total);
  const hum = new Float32Array(total);
  const rain = new Float32Array(total);
  const cape = new Float32Array(total);

  const colIdx = new Int32Array(w * 4);
  const colW = new Float64Array(w * 4);
  for (let x = 0; x < w; x++) {
    buildStencil(bounds.minLon + (x / (w - 1)) * lonSpan, nodeMinLon, nodeStep, nLon, colIdx, colW, x * 4);
  }
  const rowIdx = new Int32Array(4);
  const rowW = new Float64Array(4);

  for (let y = 0; y < h; y++) {
    buildStencil(rasterRowLatitude(y, h, bounds), nodeMinLat, nodeStep, nLat, rowIdx, rowW, 0);
    const rowOffset = y * w;
    for (let x = 0; x < w; x++) {
      const idx = rowOffset + x;
      const co = x * 4;
      const elev = elevation ? elevation[idx] : TERRAIN_FALLBACK_METERS;
      const refElev = Math.max(0, applyStencil(input.nodeElev, nLon, rowIdx, rowW, colIdx, colW, co));
      const elevDiff = elev - refElev;
      const oro = orographicFraction(elevDiff);

      temp[idx] = downscaleTemperature(applyStencil(input.tempsSeaLevel, nLon, rowIdx, rowW, colIdx, colW, co), elev);
      hum[idx] = downscaleHumidity(applyStencil(input.hums, nLon, rowIdx, rowW, colIdx, colW, co), elevDiff);
      rain[idx] = downscaleRain(applyStencil(input.rain24h, nLon, rowIdx, rowW, colIdx, colW, co), oro);
      cape[idx] = downscaleCape(applyStencil(input.cape, nLon, rowIdx, rowW, colIdx, colW, co), oro);
    }
  }

  return { temp, hum, rain, cape };
}
