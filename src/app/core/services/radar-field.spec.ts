import { describe, expect, it } from 'vitest';
import {
  ECHO_FADE_FULL,
  ECHO_FADE_START,
  RADAR_COLOR_STOPS,
  RADAR_FIELD_MAX,
  blurSeparable,
  dequantizeRadar,
  echoAlphaFeather,
  gaussianKernel,
  quantizeRadarField,
  resampleBilinear,
} from './radar-field';

describe('gaussianKernel', () => {
  it('is normalised, symmetric and peaks in the middle', () => {
    for (const sigma of [0.8, 2.2, 4]) {
      const k = gaussianKernel(sigma);
      expect(k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      const mid = (k.length - 1) / 2;
      expect(k[mid]).toBe(Math.max(...k));
      for (let i = 0; i < mid; i++) expect(k[i]).toBeCloseTo(k[k.length - 1 - i], 9);
    }
  });

  it('covers three standard deviations by default', () => {
    expect(gaussianKernel(2).length).toBe(13);
  });
});

describe('blurSeparable', () => {
  const size = 31;
  const k = gaussianKernel(2);

  it('keeps a flat field flat, including at the edges', () => {
    const out = blurSeparable(new Float32Array(size * size).fill(3), size, k);
    for (const v of out) expect(v).toBeCloseTo(3, 4);
  });

  it('spreads a spike symmetrically and conserves it', () => {
    const src = new Float32Array(size * size);
    src[15 * size + 15] = 100;
    const out = blurSeparable(src, size, k);
    expect(out[15 * size + 15]).toBeLessThan(100);
    expect(out[15 * size + 15]).toBeGreaterThan(out[15 * size + 18]);
    expect(out[15 * size + 18]).toBeCloseTo(out[15 * size + 12], 6);
    expect(out[18 * size + 15]).toBeCloseTo(out[15 * size + 18], 6);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 2);
  });

  it('turns a hard step into a smooth monotonic ramp with no overshoot', () => {
    const src = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 16; x < size; x++) src[y * size + x] = 1;
    const out = blurSeparable(src, size, k);
    const row = Array.from(out.slice(15 * size, 16 * size));
    for (let x = 1; x < size; x++) expect(row[x]).toBeGreaterThanOrEqual(row[x - 1] - 1e-6);
    expect(Math.min(...row)).toBeGreaterThanOrEqual(-1e-6);
    expect(Math.max(...row)).toBeLessThanOrEqual(1 + 1e-6);
    const transition = row.filter(v => v > 0.02 && v < 0.98).length;
    expect(transition).toBeGreaterThanOrEqual(4); // the edge is spread over several pixels instead of one
  });
});

describe('resampleBilinear', () => {
  it('maps the corners onto the corners and interpolates between source pixels', () => {
    const src = Float32Array.from([0, 10, 20, 30]); // 2 x 2
    const out = resampleBilinear(src, 2, 2, 5);
    expect(out[0]).toBe(0);
    expect(out[4]).toBeCloseTo(10, 6);
    expect(out[20]).toBeCloseTo(20, 6);
    expect(out[24]).toBeCloseTo(30, 6);
    expect(out[12]).toBeCloseTo(15, 6); // the centre is the average of the four
    expect(out[2]).toBeCloseTo(5, 6);
  });

  it('never invents values outside the source range, and keeps a constant constant', () => {
    const src = Float32Array.from({ length: 49 }, (_, i) => (i * 37) % 11);
    const out = resampleBilinear(src, 7, 7, 40);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(Math.min(...src));
    expect(Math.max(...out)).toBeLessThanOrEqual(Math.max(...src));
    for (const v of resampleBilinear(new Float32Array(25).fill(2.5), 5, 5, 33)) expect(v).toBeCloseTo(2.5, 6);
  });

  it('replaces the staircase of a nearest-neighbour stretch with a smooth gradient', () => {
    // a one-pixel-wide class band (value 1.2) on a 9-pixel line, stretched to 36 pixels
    const src = new Float32Array(81);
    for (let y = 0; y < 9; y++) src[y * 9 + 4] = 1.2;
    const out = resampleBilinear(src, 9, 9, 36);
    const row = Array.from(out.slice(18 * 36, 19 * 36));
    const between = row.filter(v => v > 0.01 && v < 1.19).length;
    expect(between).toBeGreaterThanOrEqual(6); // nearest-neighbour has no in-between pixels at all: only 0 and 1.2
    expect(Math.max(...row)).toBeGreaterThan(1.0);
  });

  it('copes with a source that is a single pixel wide or tall', () => {
    const out = resampleBilinear(Float32Array.from([1, 2, 3]), 3, 1, 4);
    expect(out.length).toBe(16);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...out)).toBeLessThanOrEqual(3);
  });
});

describe('echoAlphaFeather', () => {
  it('is invisible for noise, fully opaque for real echoes, and smooth in between', () => {
    expect(echoAlphaFeather(0)).toBe(0);
    expect(echoAlphaFeather(ECHO_FADE_START)).toBe(0);
    expect(echoAlphaFeather(ECHO_FADE_FULL)).toBe(1);
    expect(echoAlphaFeather(5)).toBe(1);
    let last = 0;
    for (let v = ECHO_FADE_START; v <= ECHO_FADE_FULL; v += 0.01) {
      const f = echoAlphaFeather(v);
      expect(f).toBeGreaterThanOrEqual(last - 1e-9);
      expect(f).toBeLessThanOrEqual(1);
      last = f;
    }
  });

  it('fades the lightest class in gently rather than switching it on', () => {
    const lightest = echoAlphaFeather(0.5); // the first colour class
    expect(lightest).toBeGreaterThan(0.3);
    expect(lightest).toBeLessThan(0.9);
    expect(echoAlphaFeather(1.2)).toBe(1); // light rain and heavier are not faded
  });
});

describe('quantizeRadarField', () => {
  it('keeps every intensity within one byte step, clips the ends, and leaves rain-free pixels at zero', () => {
    const values = [0, 0.04, 0.5, 1.2, 2.0, 3.0, 4.4, 5.2, 5.99, 7, -1];
    const bytes = quantizeRadarField(Float32Array.from(values));
    const step = RADAR_FIELD_MAX / 255;
    values.forEach((v, i) => {
      const expected = Math.min(Math.max(v, 0), RADAR_FIELD_MAX);
      expect(Math.abs(dequantizeRadar(bytes[i]) - expected)).toBeLessThanOrEqual(step / 2 + 1e-6);
    });
    expect(bytes[0]).toBe(0);
    expect(bytes[9]).toBe(255);
    expect(bytes[10]).toBe(0);
  });

  it('is finer than the colour scale, so classes and the colours between them survive', () => {
    const stops = RADAR_COLOR_STOPS.map(s => s.val);
    const gaps = stops.slice(1).map((v, i) => v - stops[i]);
    expect(RADAR_FIELD_MAX / 255).toBeLessThan(Math.min(...gaps) / 10);
    expect(RADAR_FIELD_MAX).toBeGreaterThan(stops[stops.length - 1]);
  });
});
