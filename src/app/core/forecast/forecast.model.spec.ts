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

const GRID: ForecastGrid = { latMax: 22, latMin: 4, lonMin: 68, lonMax: 90, step: 0.1, nx: 221, ny: 181 };

describe('mercatorUnitY', () => {
  it('stays finite at the poles of a whole-globe grid, and matches the usual value elsewhere', () => {
    expect(Number.isFinite(mercatorUnitY(90))).toBe(true);
    expect(Number.isFinite(mercatorUnitY(-90))).toBe(true);
    expect(mercatorUnitY(0)).toBeCloseTo(0.5, 9);
    expect(mercatorUnitY(14.5)).toBeLessThan(mercatorUnitY(5.5));
  });
});

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

describe('picture addresses and builds', () => {
  it('puts the build on every picture address, so a run built again is fetched afresh', async () => {
    const { ForecastCatalogService } = await import('./forecast-catalog.service');
    const catalog = new ForecastCatalogService();
    expect(catalog.fieldUrl('t850', 12, '20261007T00Z')).toBe('https://gowthamgta.github.io/Atmos/ecmwf_ifs/20261007T00Z/t850/012.png');
    expect(catalog.fieldUrl('t850', 12, '20261007T00Z', '20261007T1027Z')).toBe('https://gowthamgta.github.io/Atmos/ecmwf_ifs/20261007T00Z/t850/012.png?b=20261007T1027Z');
  });

  it('keeps the loader cache apart for two builds of one run', async () => {
    const { FieldLoaderService } = await import('./field-loader.service');
    const a = FieldLoaderService.key('ecmwf_ifs', '20261007T00Z', 't850', 12, 'b1');
    const b = FieldLoaderService.key('ecmwf_ifs', '20261007T00Z', 't850', 12, 'b2');
    expect(a).not.toBe(b);
    expect(FieldLoaderService.key('ecmwf_ifs', '20261007T00Z', 't850', 12)).toBe('ecmwf_ifs/20261007T00Z/t850/12');
  });
});
