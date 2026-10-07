import { describe, expect, it } from 'vitest';
import {
  DEBLOCK_MAX_STEP,
  blurField,
  cloudCover,
  shadeCloudLayer,
  JPEG_BLOCK,
  deblockJpeg,
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

describe('deblockJpeg', () => {
  /** A picture made of flat 8 x 8 blocks, each `step` brighter than the one to its left (the look of JPEG blocking). */
  function blocky(width: number, height: number, step: number): Uint8ClampedArray {
    const px = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = 60 + Math.floor(x / JPEG_BLOCK) * step;
        px.set([v, v, v, 255], (y * width + x) * 4);
      }
    }
    return px;
  }
  const row = (px: Uint8ClampedArray, w: number, y: number) => Array.from({ length: w }, (_, x) => px[(y * w + x) * 4]);

  it('softens a small step at a block edge into a ramp, without moving the flat parts far away', () => {
    const w = 32;
    const px = blocky(w, 16, 10);
    const before = row(px, w, 4);
    deblockJpeg(px, w, 16);
    const after = row(px, w, 4);
    // across the edge between pixel 7 and 8 the jump (10) is now spread over four pixels
    expect(Math.abs(after[8] - after[7])).toBeLessThan(Math.abs(before[8] - before[7]) * 0.4);
    for (let x = 6; x < 10; x++) expect(after[x + 1]).toBeGreaterThanOrEqual(after[x]); // still a monotonic ramp
    expect(after[3]).toBe(before[3]); // far from any edge nothing changes
  });

  it('leaves real edges (big steps) alone and never touches alpha', () => {
    const w = 32;
    const px = blocky(w, 16, DEBLOCK_MAX_STEP + 20);
    const copy = px.slice();
    deblockJpeg(px, w, 16);
    expect(px).toEqual(copy);
    const flat = blocky(w, 16, 6);
    flat.forEach((_, i) => { if (i % 4 === 3) flat[i] = 77; });
    deblockJpeg(flat, w, 16);
    for (let i = 3; i < flat.length; i += 4) expect(flat[i]).toBe(77);
  });

  it('also smooths horizontal block edges, and keeps flat pictures flat', () => {
    const w = 16;
    const px = new Uint8ClampedArray(w * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < w; x++) px.set([50 + Math.floor(y / 8) * 8, 0, 0, 255], (y * w + x) * 4);
    const col = (y: number) => px[(y * w + 3) * 4];
    const stepBefore = col(8) - col(7);
    deblockJpeg(px, w, 32);
    expect(col(8) - col(7)).toBeLessThan(stepBefore * 0.4);
    const flat = new Uint8ClampedArray(16 * 16 * 4).fill(120);
    deblockJpeg(flat, 16, 16);
    expect(new Set(flat).size).toBe(1);
  });
});

describe('cloud extraction', () => {
  const px = (r: number, g: number, b: number) => Uint8ClampedArray.from([r, g, b, 255]);
  const cover = (r: number, g: number, b: number, kind: 'hrv' | 'ir' = 'hrv') => cloudCover(px(r, g, b), 1, 1, kind, 58)[0];

  it('finds white and lavender cloud but not sea, yellow land or bright sunlit land', () => {
    expect(cover(244, 245, 203)).toBeGreaterThan(0.9); // thick cloud
    expect(cover(116, 113, 160)).toBeGreaterThan(0.5); // thin lavender cloud
    expect(cover(57, 57, 58)).toBe(0); // sea
    expect(cover(103, 102, 38)).toBe(0); // land
    expect(cover(159, 158, 76)).toBe(0); // bright, sunlit land: a high blue value is not enough, it is yellow
  });

  it('reads cold, high cloud as bright in infrared', () => {
    expect(cover(250, 250, 250, 'ir')).toBeGreaterThan(0.9);
    expect(cover(40, 40, 40, 'ir')).toBe(0);
  });

  it('blurs without changing the total and spreads a spike evenly', () => {
    const size = 21;
    const f = new Float32Array(size * size);
    f[10 * size + 10] = 100;
    const out = blurField(f, size, size, 1.5);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 1);
    expect(out[10 * size + 11]).toBeCloseTo(out[10 * size + 9], 6);
    expect(out[11 * size + 10]).toBeCloseTo(out[9 * size + 10], 6);
    expect(out[10 * size + 10]).toBeLessThan(100);
  });
});

describe('shadeCloudLayer (cloud-only veil)', () => {
  /** A bright oval cloud (strongest in the middle) on sea, `size` x `size`; HRV colours: cream (low blue). */
  function oval(size: number, blue = -8): Uint8ClampedArray {
    const px = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot((x - size / 2) / (size * 0.28), (y - size / 2) / (size * 0.2));
        const cloud = Math.max(0, 1 - d * d);
        const v = cloud > 0 ? 120 + cloud * 130 : 0;
        px.set(cloud > 0.02 ? [v, v, Math.min(255, v + blue), 255] : [57, 57, 58, 255], (y * size + x) * 4);
      }
    }
    return px;
  }
  const size = 64;
  const out = shadeCloudLayer(oval(size), size, size, 'hrv', 58);
  const at = (x: number, y: number) => out.slice((y * size + x) * 4, (y * size + x) * 4 + 4);

  it('leaves the open sea clear and the cloud see-through, with a smooth edge', () => {
    expect(at(2, 2)[3]).toBe(0);
    expect(at(32, 32)[3]).toBeGreaterThan(150);
    expect(at(32, 32)[3]).toBeLessThanOrEqual(Math.round(255 * 0.72));   // the map always shows through
    let step = 0;
    for (let x = 1; x < size; x++) step = Math.max(step, Math.abs(at(x, 32)[3] - at(x - 1, 32)[3]));
    expect(step).toBeLessThan(40);
  });

  it('keeps the cloud colour of the picture (muted), and blends in the natural colour when given', () => {
    const c = at(32, 32);
    expect(c[0]).toBeGreaterThan(c[2]);                                      // cream, as in the HRV picture
    const white = new Uint8ClampedArray(size * size * 4).fill(255);
    const blended = shadeCloudLayer(oval(size), size, size, 'hrv', 58, white);
    const b = blended.slice((32 * size + 32) * 4, (32 * size + 32) * 4 + 4);
    expect(b[2]).toBeGreaterThan(c[2]);                                      // whiter with the natural colour in
  });

  it('shades night cloud from grey-blue (thin) to white (cold, thick)', () => {
    const ir = new Uint8ClampedArray(size * 4 * 4);
    for (let x = 0; x < size; x++) for (let y = 0; y < 4; y++) { const v = x < size / 2 ? 140 : 250; ir.set([v, v, v, 255], (y * size + x) * 4); }
    const night = shadeCloudLayer(ir, size, 4, 'ir', 0);
    const thin = night.slice((2 * size + 8) * 4, (2 * size + 8) * 4 + 3);
    const cold = night.slice((2 * size + 56) * 4, (2 * size + 56) * 4 + 3);
    expect(cold[0]).toBeGreaterThan(thin[0]);
    expect(thin[2]).toBeGreaterThan(thin[0]);
  });
});

describe('true-colour (FY-4B) pictures', () => {
  it('finds cloud as bright in every channel, and not green land or blue sea', () => {
    const src = new Uint8ClampedArray([
      200, 210, 215, 255,   // cloud
      60, 110, 70, 255,     // green land
      15, 30, 70, 255,      // sea
    ]);
    const cover = cloudCover(src, 3, 1, 'rgb', 0);
    expect(cover[0]).toBeGreaterThan(0.95);
    expect(cover[1]).toBe(0);
    expect(cover[2]).toBe(0);
  });

  it('keeps the picture in the full view and makes true black (no data) see-through in the infrared one', () => {
    const out = new Uint8ClampedArray(4);
    shadePixel('rgb', 'picture', 60, 110, 70, 0, out, 0);
    expect(Array.from(out.slice(0, 3))).toEqual([60, 110, 70]);
    expect(out[3]).toBeGreaterThan(200);
    shadePixel('ir', 'picture', 0, 0, 0, 0, out, 0);
    expect(out[3]).toBe(0);
    shadePixel('ir', 'picture', 40, 40, 40, 0, out, 0);
    expect(out[3]).toBeGreaterThan(200);
  });
});
