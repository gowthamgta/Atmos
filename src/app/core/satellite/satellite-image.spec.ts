import { describe, expect, it } from 'vitest';
import {
  latFromMercatorY,
  mercatorHeight,
  mercatorRowMap,
  hrvBackground,
  mercatorY,
  shadePixel,
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

function shade(kind: 'hrv' | 'ir', view: 'clouds' | 'picture', r: number, g: number, b: number, bg = 58): number[] {
  const out = new Uint8ClampedArray(4);
  shadePixel(kind, view, r, g, b, bg, out, 0);
  return Array.from(out);
}

describe('shadePixel: HRV clouds view', () => {
  it('makes land and sea see-through and cloud opaque and white', () => {
    expect(shade('hrv', 'clouds', 123, 122, 60)[3]).toBe(0); // yellow land
    expect(shade('hrv', 'clouds', 57, 57, 58)[3]).toBe(0); // sea
    const [r, g, b, a] = shade('hrv', 'clouds', 247, 247, 204); // thick cloud
    expect(a).toBeGreaterThan(230);
    expect(Math.min(r, g, b)).toBeGreaterThan(200);
  });

  it('shows thin lavender cloud faintly rather than dropping it', () => {
    const a = shade('hrv', 'clouds', 117, 114, 160)[3];
    expect(a).toBeGreaterThan(40);
    expect(a).toBeLessThan(255);
  });

  it('follows the background, so dim morning light still finds cloud', () => {
    // the same cloud brightness relative to the background gives the same opacity
    expect(shade('hrv', 'clouds', 90, 90, 100, 30)[3]).toBe(shade('hrv', 'clouds', 150, 150, 160, 90)[3]);
  });
});

describe('shadePixel: other cases', () => {
  it('keeps the whole HRV picture in picture view except true black', () => {
    expect(shade('hrv', 'picture', 0, 0, 0)[3]).toBe(0);
    expect(shade('hrv', 'picture', 123, 122, 60)).toEqual([123, 122, 60, 255]);
  });

  it('draws only bright cloud in infrared cloud view, and everything in picture view', () => {
    expect(shade('ir', 'clouds', 20, 20, 20)[3]).toBe(0);
    expect(shade('ir', 'clouds', 255, 255, 255)[3]).toBeGreaterThan(200);
    expect(shade('ir', 'clouds', 140, 140, 140)[3]).toBeGreaterThan(shade('ir', 'clouds', 80, 80, 80)[3]);
    expect(shade('ir', 'picture', 20, 20, 20)[3]).toBeGreaterThan(200);
  });
});

describe('hrvBackground', () => {
  it('is the median blue value, ignoring cloud and the empty corners', () => {
    const px = new Uint8ClampedArray(4 * 7 * 100);
    for (let i = 0; i < 100; i++) px.set([60, 60, i < 80 ? 60 : 230, 255], i * 28); // 20% cloud
    expect(hrvBackground(px)).toBe(60);
    const empty = new Uint8ClampedArray(4 * 7 * 20); // all black: nothing to measure
    expect(hrvBackground(empty)).toBe(60);
  });
});

describe('toOverlayPixels', () => {
  const width = 4;
  const srcHeight = 8;
  const src = new Uint8ClampedArray(width * srcHeight * 4);
  for (let y = 0; y < srcHeight; y++) for (let x = 0; x < width; x++) src.set([y * 30, 100, 50, 255], (y * width + x) * 4);

  it('returns a picture of the requested size with values taken from the source', () => {
    const out = toOverlayPixels(src, width, srcHeight, 'hrv', 'picture', 10);
    expect(out.length).toBe(width * 10 * 4);
    for (let r = 0; r < 10; r++) {
      expect(out[r * width * 4]).toBeLessThanOrEqual(7 * 30);
      expect(out[r * width * 4 + 1]).toBe(100);
    }
  });

  it('blends between rows rather than copying, and keeps rows in order', () => {
    const out = toOverlayPixels(src, width, srcHeight, 'hrv', 'picture', 20);
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
    const out = toOverlayPixels(black, width, 2, 'hrv', 'picture', 3);
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(0);
  });
});

describe('satelliteCoordinates', () => {
  it('lists the corners clockwise from the north-west', () => {
    expect(satelliteCoordinates()).toEqual([[68, 22], [90, 22], [90, 4], [68, 4]]);
  });
});
