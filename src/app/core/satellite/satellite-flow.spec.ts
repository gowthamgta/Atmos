import { describe, it, expect } from 'vitest';
import { MotionGrid, cloudFlow, motionGrid } from './satellite-flow';

/** A cloud-like pattern (blobs of different brightness) on a w x h grid, moved by (sx, sy) cells. */
function clouds(w: number, h: number, sx = 0, sy = 0): MotionGrid {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x - sx;
      const v = y - sy;
      const s = Math.sin(u * 0.21) * Math.cos(v * 0.17) + 0.6 * Math.sin((u + 2 * v) * 0.09) + 0.4 * Math.cos(u * 0.05 - v * 0.31);
      data[y * w + x] = Math.max(0, Math.min(255, Math.round(120 + 70 * s)));
    }
  }
  return { data, w, h };
}

const mean = (a: Float32Array, k: 0 | 1) => {
  let s = 0;
  for (let i = k; i < a.length; i += 2) s += a[i];
  return s / (a.length / 2);
};

describe('cloud motion between two satellite pictures', () => {
  it('finds a pattern moved 3 cells right and 2 down', () => {
    const a = clouds(120, 100);
    const b = clouds(120, 100, 3, 2);
    const f = cloudFlow(a, b)!;
    expect(f.cols).toBeGreaterThan(4);
    expect(mean(f.data, 0) * a.w).toBeCloseTo(3, 0);
    expect(mean(f.data, 1) * a.h).toBeCloseTo(2, 0);
    expect(f.x0).toBeGreaterThan(0);
    expect(f.stepX).toBeGreaterThan(0);
  });

  it('says still for an unchanged picture and for clear sky', () => {
    const a = clouds(120, 100);
    const still = cloudFlow(a, a)!;
    expect([...still.data].every(v => v === 0)).toBe(true);
    const clear: MotionGrid = { data: new Uint8Array(120 * 100), w: 120, h: 100 };
    const none = cloudFlow(clear, clear)!;
    expect([...none.data].every(v => v === 0)).toBe(true); // no texture anywhere: no motion, never a guess
  });

  it('does not compare pictures of different sizes', () => {
    expect(cloudFlow(clouds(120, 100), clouds(100, 100))).toBeNull();
  });

  it('builds the grid from the overlay: brightness weighted by opacity', () => {
    const w = 4, h = 2;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) px.set([200, 200, 200, i < 4 ? 255 : 0], i * 4); // top row white cloud, bottom row clear
    const g = motionGrid(px, w, h, 2);
    expect(g.w).toBe(2);
    expect(g.h).toBe(1);
    expect(g.data[0]).toBe(100); // half the box cloud of 200, half clear
  });
});
