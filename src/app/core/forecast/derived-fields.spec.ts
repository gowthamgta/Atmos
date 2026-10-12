import { describe, expect, it } from 'vitest';
import { decodeRg16, ForecastGrid } from './forecast.model';
import { blendFields, differenceField, encodeFieldPixels, extremeConsensus, minAcross, rainMmToSeverity, resampleField } from './derived-fields';

const f = (...v: number[]) => new Float32Array(v);

describe('derived fields', () => {
  it('blends two fields between their times', () => {
    expect(Array.from(blendFields(f(0, 10), f(10, 20), 0.5))).toEqual([5, 15]);
    expect(Array.from(blendFields(f(0, 10), f(10, 20), 0))).toEqual([0, 10]);
    expect(Array.from(blendFields(f(0, 10), f(10, 20), 1))).toEqual([10, 20]);
  });

  it('takes the rain between two times from the running totals, never below zero, NaN where either is unknown', () => {
    const d = differenceField(f(12, 5, NaN, 7), f(2, 9, 1, NaN));
    expect(d[0]).toBe(10);
    expect(d[1]).toBe(0);               // a total cannot fall: a tiny negative from blending is rain-free
    expect(Number.isNaN(d[2])).toBe(true);
    expect(Number.isNaN(d[3])).toBe(true);
  });

  it('keeps the smallest value of the models in each cell and ignores a model with no data there', () => {
    const m = minAcross([f(3, 2, NaN, NaN), f(1, 3, 2, NaN), f(2, NaN, 1, NaN)]);
    expect(Array.from(m).slice(0, 3)).toEqual([1, 2, 1]);
    expect(Number.isNaN(m[3])).toBe(true);
  });

  it('computes continuous multi-model extreme rain consensus across neighbourhoods without letting a single smooth model zero it out', () => {
    const grid: ForecastGrid = { latMax: 11, latMin: 10, lonMin: 78, lonMax: 79, step: 0.5, nx: 3, ny: 3 };
    const m1 = f(0, 0, 0, 0, 60, 0, 0, 0, 0);
    const m2 = f(0, 0, 0, 0, 0, 50, 0, 0, 0); // slightly displaced peak
    const m3 = f(0, 0, 0, 0, 5, 0, 0, 0, 0);  // smooth AI model with low peak
    const agreed = extremeConsensus([m1, m2, m3], grid);
    expect(agreed[4]).toBeGreaterThanOrEqual(1.5);
    expect(rainMmToSeverity(0)).toBe(0);
    expect(rainMmToSeverity(10)).toBeCloseTo(0.5, 5);
    expect(rainMmToSeverity(22)).toBeCloseTo(1.0, 5);
    expect(rainMmToSeverity(50)).toBeCloseTo(2.0, 5);
    expect(rainMmToSeverity(120)).toBe(3.0);
  });

  it('puts a coarse model on the finer grid', () => {
    const coarse: ForecastGrid = { latMax: 10, latMin: 9, lonMin: 70, lonMax: 71, step: 0.5, nx: 3, ny: 3 };
    const fine: ForecastGrid = { latMax: 10, latMin: 9, lonMin: 70, lonMax: 71, step: 0.25, nx: 5, ny: 5 };
    const values = f(0, 0, 0, 0, 4, 0, 0, 0, 0);   // one peak in the middle of the coarse grid
    const out = resampleField(values, coarse, fine);
    expect(out[2 * 5 + 2]).toBe(4);                  // the middle stays at the peak
    expect(out[2 * 5 + 1]).toBe(2);                  // halfway to the neighbouring zero
    expect(resampleField(values, coarse, coarse)).toBe(values); // same grid: nothing to do
  });

  it('packs values the way the published pictures are packed, and decodes back to them', () => {
    const px = encodeFieldPixels(f(0, 1.5, 3, NaN), 0, 3);
    const back = (i: number) => decodeRg16(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], 0, 3);
    expect(back(0)).toBeCloseTo(0, 4);
    expect(back(1)).toBeCloseTo(1.5, 3);
    expect(back(2)).toBeCloseTo(3, 4);
    expect(Number.isNaN(back(3))).toBe(true);
    expect(px[3]).toBe(255);                         // opaque, so the bytes survive unpremultiplied
  });
});
