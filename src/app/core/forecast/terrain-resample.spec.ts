import { describe, expect, it } from 'vitest';
import { resampleTileRgb } from './terrain-tiles';

function tile(n: number, metresAt: (x: number, y: number) => number, land = 255): Uint8ClampedArray {
  const px = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const q = Math.round((metresAt(x, y) / 4000) * 65535);
      const o = (y * n + x) * 4;
      px[o] = q >> 8; px[o + 1] = q & 255; px[o + 2] = land; px[o + 3] = 255;
    }
  }
  return px;
}

function metres(px: Uint8ClampedArray, n: number, x: number, y: number): number {
  const o = (y * n + x) * 4;
  return ((px[o] * 256 + px[o + 1]) / 65535) * 4000;
}

describe('resampleTileRgb', () => {
  it('keeps a flat tile flat and its land fraction', () => {
    const out = resampleTileRgb(tile(4, () => 300, 128), 4, 12);
    expect(out.length).toBe(12 * 12 * 4);
    expect(Math.abs(metres(out, 12, 5, 7) - 300)).toBeLessThan(0.1);
    expect(Math.abs(out[(7 * 12 + 5) * 4 + 2] - 128)).toBeLessThanOrEqual(1);
  });

  it('keeps a slope a slope, with no false step where the two bytes roll over', () => {
    // heights from 0 to 3000 m across 4 tiles: the high byte changes inside the tile
    const src = tile(4, x => x * 1000);
    const out = resampleTileRgb(src, 4, 12);
    for (let x = 2; x < 11; x++) {          // the first and last columns clamp to the tile's edge, so no step there
      const step = metres(out, 12, x, 6) - metres(out, 12, x - 1, 6);
      expect(step).toBeCloseTo(1000 / 3, 0);   // 1000 m per source cell, 3 output pixels a cell: a smooth slope, no jump
    }
  });
});
