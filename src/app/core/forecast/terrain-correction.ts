/**
 * Terrain correction of model fields. The forecast model sees each 0.1° cell as flat ground at its mean
 * height; the real ground at a pixel is higher or lower by dz = (1 km terrain) - (model-cell mean terrain).
 * The shader (scalar-field.layer.ts) and the click inspector both use these constants and formulas.
 */

/** Standard environmental lapse rate: air cools 6.5 °C per km of height. */
export const LAPSE_RATE_C_PER_M = 0.0065;
/** Dew point falls much more slowly with height than air temperature (about 1.8 °C per km). */
export const DEWPOINT_LAPSE_C_PER_M = 0.0018;
/** d(ln saturation vapour pressure)/dT near 25 °C (Magnus), per °C. */
export const LN_ES_PER_C = 0.0617;
/**
 * Relative humidity grows as the air-minus-dew-point gap shrinks with height:
 * ln(RH) changes by LN_ES_PER_C * (lapse - dew-point lapse) * dz (a linearisation of the Magnus formula).
 */
export const RH_LOG_PER_M = LN_ES_PER_C * (LAPSE_RATE_C_PER_M - DEWPOINT_LAPSE_C_PER_M);
/** Ignore implausible height differences (steep, narrow terrain the model cannot represent). */
export const MAX_TERRAIN_DELTA_M = 1500;

export type TerrainMode = 'temperature' | 'humidity';

export function terrainDelta(fineMeters: number, modelMeters: number): number {
  return Math.min(Math.max(fineMeters - modelMeters, -MAX_TERRAIN_DELTA_M), MAX_TERRAIN_DELTA_M);
}

/** Temperature (or feels-like) at height dz above the model's own ground. */
export function adjustTemperature(tempC: number, dz: number): number {
  return tempC - LAPSE_RATE_C_PER_M * dz;
}

/** Relative humidity (%) at height dz above the model's own ground, capped at saturation. */
export function adjustHumidity(rhPercent: number, dz: number): number {
  return Math.min(100, rhPercent * Math.exp(RH_LOG_PER_M * dz));
}

export function applyTerrain(mode: TerrainMode | null, value: number, dz: number): number {
  if (mode === 'temperature') return adjustTemperature(value, dz);
  if (mode === 'humidity') return adjustHumidity(value, dz);
  return value;
}
