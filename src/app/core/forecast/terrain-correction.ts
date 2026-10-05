/**
 * 1 km terrain downscaling of model fields. Every model is published on a 0.1° grid, but it sees its own cells as
 * flat ground at their mean height, so at each 1 km pixel the real ground differs from the model's by
 * dz = (1 km terrain) - (model's ground). These formulas move each near-surface field from the model's ground to
 * the real one, using:
 *  - dz (height): temperature, feels-like, dew point, humidity, moisture column;
 *  - ridge/valley position and the coast (land fraction): wind and gusts;
 *  - wind blowing up or down the slopes: rain and low cloud (windward wetter, lee drier);
 *  - the slope facing towards or away from the sun: sunshine.
 * The shader (scalar-field.layer.ts) mirrors these constants and formulas exactly; the click card uses them here.
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
/** Water vapour thins out with height: scale height of the moisture column (m). */
export const VAPOUR_SCALE_HEIGHT_M = 2300;

/** Wind speed-up per metre a point stands above the ~4 km-smoothed terrain around it (ridges windier, valleys calmer). */
export const EXPOSURE_PER_M = 1 / 450;
export const EXPOSURE_MIN = 0.7;
export const EXPOSURE_MAX = 1.45;
/** Smoother sea surface: near the coast, sea pixels are windier and land pixels calmer than the mixed model cell. */
export const SEA_WIND_GAIN = 0.25;
export const WIND_FACTOR_MIN = 0.6;
export const WIND_FACTOR_MAX = 1.6;

/**
 * Rain from air forced up the slopes: the change in rain per m/s of lift (wind times slope) that the 1 km terrain adds
 * beyond what the model's own smoother terrain already gives it.
 */
export const OROGRAPHIC_GAIN_S_PER_M = 1.2;
export const OROGRAPHIC_MIN = 0.35;
export const OROGRAPHIC_MAX = 2.6;
/** Low cloud follows the same lift, more gently (factor ** this). */
export const LOW_CLOUD_OROGRAPHIC_POWER = 0.6;

/** Share of sunshine that is diffuse (from the whole sky, so slopes hardly change it). */
export const DIFFUSE_FRACTION = 0.3;
export const SOLAR_FACTOR_MAX = 2.2;

export type TerrainMode = 'temperature' | 'humidity' | 'dewpoint' | 'wind' | 'rain' | 'lowcloud' | 'column' | 'solar';

export function terrainDelta(fineMeters: number, modelMeters: number): number {
  return Math.min(Math.max(fineMeters - modelMeters, -MAX_TERRAIN_DELTA_M), MAX_TERRAIN_DELTA_M);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Temperature (or feels-like) at height dz above the model's own ground. */
export function adjustTemperature(tempC: number, dz: number): number {
  return tempC - LAPSE_RATE_C_PER_M * dz;
}

/** Dew point at height dz above the model's own ground. */
export function adjustDewpoint(dewC: number, dz: number): number {
  return dewC - DEWPOINT_LAPSE_C_PER_M * dz;
}

/** Relative humidity (%) at height dz above the model's own ground, capped at saturation. */
export function adjustHumidity(rhPercent: number, dz: number): number {
  return Math.min(100, rhPercent * Math.exp(RH_LOG_PER_M * dz));
}

/** Total moisture column over ground dz higher than the model's (less air above, so less water). */
export function columnFactor(dz: number): number {
  return Math.exp(-dz / VAPOUR_SCALE_HEIGHT_M);
}

/**
 * Wind multiplier at a pixel: exposure (`tpi`, metres above the smoothed terrain around it) and the coast
 * (`landFine` the pixel's land fraction, `landModel` the model cell's).
 */
export function windFactor(tpi: number, landFine: number, landModel: number): number {
  const exposure = clamp(1 + tpi * EXPOSURE_PER_M, EXPOSURE_MIN, EXPOSURE_MAX);
  const coast = 1 + SEA_WIND_GAIN * (landModel - landFine);
  return clamp(exposure * coast, WIND_FACTOR_MIN, WIND_FACTOR_MAX);
}

/**
 * Rain multiplier from the wind blowing up (or down) the slopes. `liftFine` and `liftModel` are wind · slope (m/s)
 * on the 1 km-scale terrain and on the model's own terrain; only the extra lift the model cannot see changes the rain.
 */
export function orographicFactor(liftFine: number, liftModel: number): number {
  return clamp(1 + OROGRAPHIC_GAIN_S_PER_M * (liftFine - liftModel), OROGRAPHIC_MIN, OROGRAPHIC_MAX);
}

/** Vertical lift (m/s) of wind (u east, v north, m/s) over terrain sloping by (gx, gy) metres per metre. */
export function lift(u: number, v: number, gx: number, gy: number): number {
  return u * gx + v * gy;
}

/** Low-cloud cover (%) under the same lift, capped at 100. */
export function adjustLowCloud(cloudPercent: number, factor: number): number {
  return Math.min(100, cloudPercent * Math.pow(factor, LOW_CLOUD_OROGRAPHIC_POWER));
}

/** Unit vector towards the sun in local east/north/up, for a place and time. */
export function sunVector(timeMs: number, latDeg: number, lonDeg: number): [number, number, number] {
  const { declination, eqTimeMin } = solarDeclination(timeMs);
  const d = new Date(timeMs);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  return sunVectorFrom(declination, eqTimeMin, utcMin, latDeg, lonDeg);
}

/** Sun declination (radians) and equation of time (minutes) for a day (NOAA's simple formula, about 1° accurate). */
export function solarDeclination(timeMs: number): { declination: number; eqTimeMin: number } {
  const year = new Date(timeMs).getUTCFullYear();
  const dayOfYear = (timeMs - Date.UTC(year, 0, 0)) / 86_400_000;
  const g = (2 * Math.PI / 365) * (dayOfYear - 1);
  const declination =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eqTimeMin =
    229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  return { declination, eqTimeMin };
}

/** Same as sunVector, from precomputed declination and equation of time (the shader does exactly this per pixel). */
export function sunVectorFrom(declination: number, eqTimeMin: number, utcMin: number, latDeg: number, lonDeg: number): [number, number, number] {
  const rad = Math.PI / 180;
  const hourAngle = ((utcMin + eqTimeMin + 4 * lonDeg) / 4 - 180) * rad;
  const lat = latDeg * rad;
  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const north = Math.cos(lat) * Math.sin(declination) - Math.sin(lat) * Math.cos(declination) * Math.cos(hourAngle);
  const up = Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  return [east, north, up];
}

/**
 * Sunshine multiplier on a slope rising by (gx east, gy north) metres per metre, with the sun along `sun` (east, north,
 * up). The direct part follows the angle between slope and sun; the diffuse part only the share of sky the slope sees.
 */
export function solarFactor(gx: number, gy: number, sun: readonly [number, number, number]): number {
  const up = sun[2];
  if (up <= 0.05) return 1; // sun on or below the horizon: nothing to redistribute
  const len = Math.hypot(gx, gy, 1);
  const nx = -gx / len;
  const ny = -gy / len;
  const nz = 1 / len;
  const cosI = Math.max(0, nx * sun[0] + ny * sun[1] + nz * up);
  const direct = (1 - DIFFUSE_FRACTION) * (cosI / Math.max(up, 0.1));
  const diffuse = DIFFUSE_FRACTION * (1 + nz) / 2;
  return clamp(direct + diffuse, 0, SOLAR_FACTOR_MAX);
}

/** Everything about the ground at one point that the corrections need. */
export interface PointTerrain {
  /** 1 km ground height and the model's ground (m), and their difference (clamped). */
  fine: number;
  model: number;
  dz: number;
  /** Metres above the ~4 km-smoothed terrain around the point (ridges positive, valleys negative). */
  tpi: number;
  landFine: number;
  landModel: number;
  /** Slope (m/m, east and north) of the smoothed terrain and of the model's terrain, for windward lift. */
  slope: [number, number];
  modelSlope: [number, number];
  /** Slope of the 1 km terrain, for sunshine on hillsides. */
  fineSlope: [number, number];
}

/** Optional context for the corrections that depend on more than height. */
export interface TerrainContext {
  terrain: PointTerrain;
  /** Wind (u, v, m/s) that drives the orographic lift: 850 hPa when the model has it, else 10 m. */
  liftWind?: [number, number] | null;
  timeMs?: number;
  lat?: number;
  lon?: number;
}

/** Apply a layer's terrain correction to a model value at one point (the click card; the map does the same on the GPU). */
export function applyTerrain(mode: TerrainMode | null, value: number, ctx: TerrainContext | number | null): number {
  if (mode === null || ctx === null || Number.isNaN(value)) return value;
  const dz = typeof ctx === 'number' ? ctx : ctx.terrain.dz;
  switch (mode) {
    case 'temperature':
      return adjustTemperature(value, dz);
    case 'humidity':
      return adjustHumidity(value, dz);
    case 'dewpoint':
      return adjustDewpoint(value, dz);
    case 'column':
      return value * columnFactor(dz);
  }
  if (typeof ctx === 'number') return value; // the rest need more than the height difference
  const t = ctx.terrain;
  switch (mode) {
    case 'wind':
      return value * windFactor(t.tpi, t.landFine, t.landModel);
    case 'rain':
    case 'lowcloud': {
      if (!ctx.liftWind) return value;
      const [u, v] = ctx.liftWind;
      const f = orographicFactor(lift(u, v, t.slope[0], t.slope[1]), lift(u, v, t.modelSlope[0], t.modelSlope[1]));
      return mode === 'rain' ? value * f : adjustLowCloud(value, f);
    }
    case 'solar': {
      if (ctx.timeMs === undefined || ctx.lat === undefined || ctx.lon === undefined) return value;
      return value * solarFactor(t.fineSlope[0], t.fineSlope[1], sunVector(ctx.timeMs, ctx.lat, ctx.lon));
    }
  }
  return value;
}
