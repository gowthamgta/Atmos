import { describe, expect, it } from 'vitest';
import {
  latFromMercatorY,
  mercatorHeight,
  mercatorRowMap,
  mercatorY,
  pixelAlpha,
  satelliteCoordinates,
  toOverlayPixels,
} from './satellite-image';

describe('mercator helpers', () => {
  it('inverts mercatorY', () => {
    for (const lat of [-30, 0, 4, 13, 22, 60]) expect(latFromMercatorY(mercatorY(lat))).toBeCloseTo(lat, 8);
  });

  it('gives a slightly taller picture than plain latitude would for 4-22 N', () => {
    const h = mercatorHeight(1100);
    expect(h).toBeGreaterThan(900); // the plain-latitude picture is 900 tall
    expect(h).toBeLessThan(1000);
  });
});

describe('mercatorRowMap', () => {
  const rows = mercatorRowMap(900, 950);

  it('runs top to bottom through the source, in range', () => {
    expect(rows[0]).toBeGreaterThanOrEqual(0);
    expect(rows[0]).toBeLessThan(2);
    expect(rows.at(-1)!).toBeGreaterThan(897);
    expect(rows.at(-1)!).toBeLessThanOrEqual(899);
    for (let i = 1; i < rows.length; i++) expect(rows[i]).toBeGreaterThan(rows[i - 1] - 1e-6);
  });

  it('steps less through the source near the top (north), where a Mercator row covers fewer degrees', () => {
    const topStep = rows[11] - rows[10];
    const bottomStep = rows[rows.length - 1] - rows[rows.length - 2];
    expect(topStep).toBeLessThan(bottomStep);
  });
});

describe('pixelAlpha', () => {
  it('keeps colour pictures opaque except for true black', () => {
    expect(pixelAlpha('dark-fade', 0, 0, 0)).toBe(0);
    expect(pixelAlpha('dark-fade', 30, 40, 60)).toBe(255);
    expect(pixelAlpha('dark-fade', 8, 4, 2)).toBeGreaterThan(0);
    expect(pixelAlpha('dark-fade', 8, 4, 2)).toBeLessThan(255);
  });

  it('draws only bright cloud in infrared and fades the dark ground out', () => {
    expect(pixelAlpha('luma', 20, 20, 20)).toBe(0);
    expect(pixelAlpha('luma', 255, 255, 255)).toBeGreaterThan(200);
    expect(pixelAlpha('luma', 140, 140, 140)).toBeGreaterThan(pixelAlpha('luma', 80, 80, 80));
  });
});

describe('toOverlayPixels', () => {
  const width = 4;
  const srcHeight = 8;
  const src = new Uint8ClampedArray(width * srcHeight * 4);
  for (let y = 0; y < srcHeight; y++) for (let x = 0; x < width; x++) src.set([y * 30, 100, 50, 255], (y * width + x) * 4);

  it('returns a picture of the requested size with values taken from the source', () => {
    const out = toOverlayPixels(src, width, srcHeight, 'dark-fade', 10);
    expect(out.length).toBe(width * 10 * 4);
    for (let r = 0; r < 10; r++) {
      expect(out[r * width * 4]).toBeLessThanOrEqual(7 * 30);
      expect(out[r * width * 4 + 1]).toBe(100);
    }
  });

  it('blends between rows rather than copying, and keeps rows in order', () => {
    const out = toOverlayPixels(src, width, srcHeight, 'dark-fade', 20);
    let last = -1;
    for (let r = 0; r < 20; r++) {
      const v = out[r * width * 4];
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
    const distinct = new Set(Array.from({ length: 20 }, (_, r) => out[r * width * 4])).size;
    expect(distinct).toBeGreaterThan(8); // more than the 8 source rows: in-between values exist
  });

  it('makes black see-through', () => {
    const black = new Uint8ClampedArray(width * 2 * 4);
    for (let i = 0; i < black.length; i += 4) black[i + 3] = 255;
    const out = toOverlayPixels(black, width, 2, 'dark-fade', 3);
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(0);
  });
});

describe('satelliteCoordinates', () => {
  it('lists the corners clockwise from the north-west', () => {
    expect(satelliteCoordinates()).toEqual([[68, 22], [90, 22], [90, 4], [68, 4]]);
  });
});
