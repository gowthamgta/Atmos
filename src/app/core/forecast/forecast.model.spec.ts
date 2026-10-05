import { describe, expect, it } from 'vitest';
import {
  ForecastGrid,
  bracketSteps,
  decodeRg16,
  gridPosition,
  mercatorUnitX,
  mercatorUnitY,
  sampleGrid,
} from './forecast.model';
import { FORECAST_LAYERS, buildPaletteLut, forecastLayerById, layerAvailable, legendPosition } from './forecast-layers';

const GRID: ForecastGrid = { latMax: 22, latMin: 4, lonMin: 68, lonMax: 90, step: 0.1, nx: 221, ny: 181 };

describe('bracketSteps', () => {
  const t = [0, 3, 6, 12].map(h => h * 3_600_000);

  it('blends between the surrounding steps', () => {
    expect(bracketSteps(t, 4.5 * 3_600_000)).toEqual({ a: 1, b: 2, mix: 0.5 });
    expect(bracketSteps(t, 9 * 3_600_000)).toEqual({ a: 2, b: 3, mix: 0.5 });
  });

  it('returns an exact step with mix 0 or 1 at the boundary', () => {
    expect(bracketSteps(t, 3 * 3_600_000)).toEqual({ a: 1, b: 2, mix: 0 });
    expect(bracketSteps(t, 12 * 3_600_000)).toEqual({ a: 3, b: 3, mix: 0 });
  });

  it('clamps outside the range and handles an empty list', () => {
    expect(bracketSteps(t, -5)).toEqual({ a: 0, b: 0, mix: 0 });
    expect(bracketSteps(t, 1e12)).toEqual({ a: 3, b: 3, mix: 0 });
    expect(bracketSteps([], 5)).toEqual({ a: 0, b: 0, mix: 0 });
  });
});

describe('decodeRg16', () => {
  it('maps 0 and 65535 to the range ends', () => {
    expect(decodeRg16(0, 0, 0, -10, 50)).toBe(-10);
    expect(decodeRg16(255, 255, 0, -10, 50)).toBeCloseTo(50, 9);
  });

  it('reads high and low bytes, and flags no-data', () => {
    expect(decodeRg16(128, 0, 0, 0, 65535)).toBeCloseTo(32768, 6);
    expect(decodeRg16(10, 10, 255, 0, 100)).toBeNaN();
  });
});

describe('mercator helpers', () => {
  it('puts the equator and prime meridian at the centre', () => {
    expect(mercatorUnitX(0)).toBe(0.5);
    expect(mercatorUnitY(0)).toBeCloseTo(0.5, 12);
  });

  it('increases southward (y grows as latitude falls)', () => {
    expect(mercatorUnitY(4)).toBeGreaterThan(mercatorUnitY(22));
  });
});

describe('sampleGrid', () => {
  // value = column index, so sampling at lon returns (lon - lonMin) / step
  const values = new Float32Array(GRID.nx * GRID.ny);
  for (let r = 0; r < GRID.ny; r++) for (let c = 0; c < GRID.nx; c++) values[r * GRID.nx + c] = c;

  it('interpolates bilinearly between cells', () => {
    expect(sampleGrid(values, GRID, 13.0, 80.05)).toBeCloseTo(120.5, 4);
    expect(gridPosition(GRID, 13, 80)).toEqual({ x: expect.closeTo(120, 6), y: expect.closeTo(90, 6) });
  });

  it('returns NaN outside the domain', () => {
    expect(sampleGrid(values, GRID, 30, 80)).toBeNaN();
    expect(sampleGrid(values, GRID, 13, 60)).toBeNaN();
  });

  it('ignores no-data corners and gives NaN only when all are missing', () => {
    const v = new Float32Array(values);
    v[90 * GRID.nx + 120] = NaN;
    expect(sampleGrid(v, GRID, 13.0, 80.05)).toBeCloseTo(121, 4); // only the valid neighbour (col 121) counts
    v.fill(NaN);
    expect(sampleGrid(v, GRID, 13, 80)).toBeNaN();
  });
});

describe('forecast layer registry', () => {
  it('has unique ids and sane ranges', () => {
    const ids = FORECAST_LAYERS.map(l => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of FORECAST_LAYERS) {
      expect(l.max).toBeGreaterThan(l.min);
      expect(l.stops.length).toBeGreaterThanOrEqual(2);
      const scale = l.displayScale ?? 1; // ticks are in the displayed unit, the range in the field's own unit
      expect(l.ticks.every(t => t / scale >= l.min && t / scale <= l.max)).toBe(true);
    }
  });

  it('only references pipeline variables that exist', () => {
    const published = ['t2m', 'rh', 'feels', 'u10', 'v10', 'gust', 'msl', 'precip', 'cloud', 'cape', 'tcwv'];
    for (const l of FORECAST_LAYERS) {
      expect(published).toContain(l.varId);
      if (l.varId2) expect(published).toContain(l.varId2);
    }
  });

  it('builds an opaque palette that starts and ends on the first and last colour', () => {
    const lut = buildPaletteLut(['#000000', '#ffffff']);
    expect(lut.length).toBe(256 * 4);
    expect([...lut.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...lut.slice(-4)]).toEqual([255, 255, 255, 255]);
    expect(lut[128 * 4]).toBeGreaterThan(120);
    expect(lut[128 * 4]).toBeLessThan(135);
  });

  it('positions legend ticks with the layer gamma', () => {
    const rain = forecastLayerById('rain')!;
    expect(legendPosition(rain, 0)).toBe(0);
    expect(legendPosition(rain, 20)).toBe(1);
    expect(legendPosition(rain, 5)).toBeCloseTo(0.5, 6); // sqrt(5/20)
    expect(forecastLayerById('nope')).toBeNull();
  });

  it('places km/h ticks using the m/s field range', () => {
    const wind = forecastLayerById('wind')!;
    expect(wind.varId2).toBe('v10');
    expect(legendPosition(wind, 72)).toBeCloseTo(1, 9); // 20 m/s = 72 km/h is the top of the palette
    expect(legendPosition(wind, 36)).toBeCloseTo(0.5, 9);
  });

  it('marks layers unavailable when a model does not publish their variables', () => {
    const aifs = { t2m: {}, rh: {}, feels: {}, u10: {}, v10: {}, msl: {}, precip: {}, cloud: {} }; // no gust, cape, tcwv
    const available = FORECAST_LAYERS.filter(l => layerAvailable(l, aifs)).map(l => l.id);
    expect(available).toEqual(['temp', 'feels', 'humidity', 'wind', 'rain', 'clouds', 'pressure']);
    expect(layerAvailable(forecastLayerById('gust')!, aifs)).toBe(false);
    expect(layerAvailable(forecastLayerById('wind')!, { u10: {} })).toBe(false); // needs v10 as well
    expect(layerAvailable(forecastLayerById('cape')!, null)).toBe(true); // manifest not loaded yet
  });
});
