import { describe, expect, it } from 'vitest';
import { sunElevationDeg } from '../satellite/satellite.config';
import {
  insetWeight,
  EXPOSURE_MAX,
  OROGRAPHIC_MAX,
  OROGRAPHIC_MIN,
  PointTerrain,
  SOLAR_FACTOR_MAX,
  WIND_FACTOR_MIN,
  adjustDewpoint,
  adjustLowCloud,
  applyTerrain,
  columnFactor,
  lift,
  orographicFactor,
  solarFactor,
  sunVector,
  windFactor,
} from './terrain-correction';

const T = (iso: string) => Date.parse(iso);

describe('height corrections', () => {
  it('lowers the dew point slowly with height', () => {
    expect(adjustDewpoint(24, 1000)).toBeCloseTo(22.2, 9);
    expect(adjustDewpoint(24, -500)).toBeCloseTo(24.9, 9);
  });

  it('thins the moisture column over higher ground', () => {
    expect(columnFactor(0)).toBe(1);
    expect(columnFactor(1000)).toBeCloseTo(Math.exp(-1000 / 2300), 9);
    expect(columnFactor(-300)).toBeGreaterThan(1);
  });
});

describe('windFactor', () => {
  it('is 1 on open flat land and stronger on ridges, weaker in valleys, within limits', () => {
    expect(windFactor(0, 1, 1)).toBe(1);
    expect(windFactor(150, 1, 1)).toBeGreaterThan(1.25);
    expect(windFactor(-150, 1, 1)).toBeLessThan(0.75);
    expect(windFactor(5000, 1, 1)).toBe(EXPOSURE_MAX);
    expect(windFactor(-5000, 1, 0)).toBe(WIND_FACTOR_MIN);
  });

  it('makes the sea side of a coastal model cell windier than its land side', () => {
    expect(windFactor(0, 0, 0.5)).toBeGreaterThan(1); // sea pixel in a half-land cell
    expect(windFactor(0, 1, 0.5)).toBeLessThan(1); // land pixel in the same cell
    expect(windFactor(0, 0, 0)).toBe(1); // open sea: nothing to correct
  });
});

describe('orographic lift', () => {
  it('measures lift as wind times slope', () => {
    // a 10 m/s westerly onto a slope rising 5 m per 100 m eastward (the Western Ghats in the monsoon)
    expect(lift(10, 0, 0.05, 0)).toBeCloseTo(0.5, 9);
    expect(lift(10, 0, -0.05, 0)).toBeCloseTo(-0.5, 9);
    expect(lift(0, 10, 0.05, 0)).toBe(0); // wind along the slope lifts nothing
  });

  it('only adds what the model terrain misses, wetter upwind and drier downwind, within limits', () => {
    expect(orographicFactor(0.3, 0.3)).toBe(1);
    expect(orographicFactor(0.8, 0.3)).toBeCloseTo(1.6, 9);
    expect(orographicFactor(-0.2, 0.3)).toBeCloseTo(0.4, 9);
    expect(orographicFactor(10, 0)).toBe(OROGRAPHIC_MAX);
    expect(orographicFactor(-10, 0)).toBe(OROGRAPHIC_MIN);
  });

  it('thickens low cloud more gently than rain and never above 100 %', () => {
    expect(adjustLowCloud(40, 2)).toBeGreaterThan(40);
    expect(adjustLowCloud(40, 2)).toBeLessThan(80);
    expect(adjustLowCloud(90, 2.6)).toBe(100);
  });
});

describe('sunshine on slopes', () => {
  it('points the sun vector up at local noon and agrees with the satellite sun-height formula', () => {
    for (const iso of ['2026-10-05T03:00:00Z', '2026-10-05T06:45:00Z', '2026-10-05T11:00:00Z', '2026-03-20T12:00:00Z']) {
      const [e, n, up] = sunVector(T(iso), 13, 79);
      expect(Math.hypot(e, n, up)).toBeCloseTo(1, 6);
      expect((Math.asin(up) * 180) / Math.PI).toBeCloseTo(sunElevationDeg(T(iso), 13, 79), 4);
    }
    const morning = sunVector(T('2026-10-05T02:00:00Z'), 13, 79);
    expect(morning[0]).toBeGreaterThan(0); // the morning sun is in the east
  });

  it('is 1 on flat ground and brightens slopes facing the sun, darkens those facing away', () => {
    const sun: [number, number, number] = [0.6, 0, 0.8]; // sun in the east, 53° up
    expect(solarFactor(0, 0, sun)).toBeCloseTo(1, 9);
    expect(solarFactor(-0.3, 0, sun)).toBeGreaterThan(1.05); // slope falling to the east faces the sun
    expect(solarFactor(0.3, 0, sun)).toBeLessThan(0.95);
    expect(solarFactor(-50, 0, [0.99, 0, 0.1])).toBeLessThanOrEqual(SOLAR_FACTOR_MAX);
    expect(solarFactor(0.3, 0, [0, 0, -0.2])).toBe(1); // night: nothing to redistribute
  });
});

describe('applyTerrain', () => {
  const flat: PointTerrain = {
    fine: 1500, model: 500, dz: 1000, tpi: 0, landFine: 1, landModel: 1, slope: [0, 0], modelSlope: [0, 0], fineSlope: [0, 0],
  };

  it('accepts a bare height difference for the height-only modes', () => {
    expect(applyTerrain('temperature', 20, 100)).toBeCloseTo(19.35, 9);
    expect(applyTerrain('wind', 10, 100)).toBe(10); // needs more than a height
  });

  it('leaves values alone without a context, for NaN, or when the inputs a mode needs are missing', () => {
    expect(applyTerrain('temperature', 20, null)).toBe(20);
    expect(applyTerrain('temperature', NaN, { terrain: flat })).toBeNaN();
    expect(applyTerrain('rain', 3, { terrain: { ...flat, slope: [0.05, 0] } })).toBe(3); // no lift wind
    expect(applyTerrain('solar', 600, { terrain: { ...flat, fineSlope: [0.3, 0] } })).toBe(600); // no time
  });

  it('applies every mode from a full context', () => {
    const ctx = { terrain: { ...flat, slope: [0.05, 0] as [number, number] }, liftWind: [10, 0] as [number, number] };
    expect(applyTerrain('rain', 2, ctx)).toBeCloseTo(2 * 1.6, 9);
    expect(applyTerrain('column', 50, ctx)).toBeCloseTo(50 * Math.exp(-1000 / 2300), 9);
    expect(applyTerrain('dewpoint', 24, ctx)).toBeCloseTo(22.2, 9);
    const noon = { terrain: { ...flat, fineSlope: [0, 0.3] as [number, number] }, timeMs: T('2026-12-21T06:45:00Z'), lat: 13, lon: 79 };
    // in December the noon sun is in the south, so a slope rising to the north (facing south) gets more sun
    expect(applyTerrain('solar', 600, noon)).toBeGreaterThan(600);
  });
});

describe('the 90 m inset blend', () => {
  const b = { lonMin: 76, latMin: 8, lonMax: 80, latMax: 13 };

  it('is 0 at the inset edge, 1 well inside, and linear across the ramp', () => {
    expect(insetWeight(10, 76, b)).toBe(0);
    expect(insetWeight(10, 79.9, b)).toBe(1);                   // 0.1 deg inside the east edge
    expect(insetWeight(12.99, 78, b)).toBeCloseTo(0.2, 6);     // 0.01 deg inside the north edge, of a 0.05 deg ramp
    expect(insetWeight(7.9, 78, b)).toBe(0);                    // outside: never the fine grid
  });
});
