import { describe, expect, it } from 'vitest';
import { INSPECT_VARS, blendTime, buildPointRows, windFromUV } from './point-forecast';
import {
  LAPSE_RATE_C_PER_M,
  MAX_TERRAIN_DELTA_M,
  RH_LOG_PER_M,
  adjustHumidity,
  adjustTemperature,
  applyTerrain,
  terrainDelta,
} from './terrain-correction';

describe('terrain correction', () => {
  it('cools 6.5 °C per km above the model ground and warms below it', () => {
    expect(adjustTemperature(30, 1000)).toBeCloseTo(30 - 6.5, 9);
    expect(adjustTemperature(30, -200)).toBeCloseTo(31.3, 9);
    expect(adjustTemperature(25, 0)).toBe(25);
  });

  it('raises humidity with height (capped at 100) and lowers it below the model ground', () => {
    expect(adjustHumidity(60, 0)).toBe(60);
    expect(adjustHumidity(60, 700)).toBeCloseTo(60 * Math.exp(RH_LOG_PER_M * 700), 9);
    expect(adjustHumidity(60, 700)).toBeGreaterThan(60);
    expect(adjustHumidity(95, 1000)).toBe(100);
    expect(adjustHumidity(60, -500)).toBeLessThan(60);
  });

  it('uses a humidity gain consistent with a 4.7 °C/km shrinking of the dew-point gap', () => {
    // 0.0617 per °C of saturation vapour pressure * (6.5 - 1.8) °C per km
    expect(RH_LOG_PER_M * 1000).toBeCloseTo(0.0617 * 4.7, 3);
    expect(LAPSE_RATE_C_PER_M).toBe(0.0065);
  });

  it('clamps the height difference and ignores unrelated modes', () => {
    expect(terrainDelta(2000, 100)).toBe(MAX_TERRAIN_DELTA_M);
    expect(terrainDelta(0, 1900)).toBe(-MAX_TERRAIN_DELTA_M);
    expect(terrainDelta(500, 430)).toBe(70);
    expect(applyTerrain(null, 12, 800)).toBe(12);
    expect(applyTerrain('temperature', 20, 100)).toBeCloseTo(19.35, 9);
  });
});

describe('point forecast helpers', () => {
  it('blends time steps and falls back when one side has no data', () => {
    expect(blendTime(10, 20, 0.25)).toBe(12.5);
    expect(blendTime(NaN, 7, 0.9)).toBe(7);
    expect(blendTime(7, NaN, 0.1)).toBe(7);
    expect(blendTime(NaN, NaN, 0.5)).toBeNaN();
  });

  it('gives meteorological wind direction (where the wind comes FROM)', () => {
    expect(windFromUV(0, -5).fromDeg).toBeCloseTo(0, 6); // blowing south = from the north
    expect(windFromUV(-5, 0).fromDeg).toBeCloseTo(90, 6); // blowing west = from the east
    expect(windFromUV(0, 5).fromDeg).toBeCloseTo(180, 6);
    expect(windFromUV(5, 0).fromDeg).toBeCloseTo(270, 6);
    expect(windFromUV(3, 4).speedMs).toBeCloseTo(5, 9);
  });

  const values = Object.fromEntries(INSPECT_VARS.map(v => [v, 0])) as Record<(typeof INSPECT_VARS)[number], number>;
  Object.assign(values, { t2m: 30, feels: 34, rh: 70, u10: 0, v10: -5, gust: 10, precip: 2.34, cloud: 80, msl: 1008.4, cape: 1500 });

  it('marks only temperature, feels-like and humidity as terrain-adjusted', () => {
    const rows = buildPointRows(values, 1000);
    expect(rows.filter(r => r.terrainAdjusted).map(r => r.id)).toEqual(['temp', 'feels', 'humidity']);
    expect(rows.find(r => r.id === 'temp')!.text).toBe('23.5 °C');
    expect(rows.find(r => r.id === 'wind')!.text).toMatch(/^18 km\/h from N/);
    expect(rows.find(r => r.id === 'rain')!.text).toBe('2.3 mm/h');
    expect(rows.find(r => r.id === 'pressure')!.text).toBe('1008 hPa');
  });

  it('shows raw model values when the terrain is not available', () => {
    const rows = buildPointRows(values, null);
    expect(rows.some(r => r.terrainAdjusted)).toBe(false);
    expect(rows.find(r => r.id === 'temp')!.text).toBe('30.0 °C');
  });
});
