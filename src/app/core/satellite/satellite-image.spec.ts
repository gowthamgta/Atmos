import { describe, expect, it } from 'vitest';
import {
  DEBLOCK_MAX_STEP,
  blurField,
  blurFieldWide,
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

  it('gives a slightly taller picture than plain latitude would for 5.5-14.5 N', () => {
    const h = mercatorHeight(1100);
    expect(h).toBeGreaterThan(600); // the plain-latitude picture is 600 tall (9 of 16.5 degrees)
    expect(h).toBeLessThan(620);
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
    expect(satelliteCoordinates()).toEqual([[73, 14.5], [89.5, 14.5], [89.5, 5.5], [73, 5.5]]);
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

  it('finds very bright yellow (low) cloud without the natural-colour picture, and any yellow it calls white', () => {
    expect(cover(222, 220, 95)).toBeGreaterThan(0.5);    // low cloud
    const white = Float32Array.from([1]);
    expect(cloudCover(px(160, 158, 70), 1, 1, 'hrv', 58, white)[0]).toBeGreaterThan(0.9);
    expect(cloudCover(px(160, 158, 70), 1, 1, 'hrv', 58, Float32Array.from([0]))[0]).toBe(0);
  });

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

describe('shadeCloudLayer (cloud only)', () => {
  const W = 40, H = 10;
  /** A row picture: sea, yellow land, yellow low cloud, white high cloud, and a 1-pixel bright line of cloud. */
  function scene(): Uint8ClampedArray {
    const px = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = x < 8 ? [57, 57, 58] : x < 16 ? [110, 108, 42] : x < 24 ? [214, 210, 92] : x < 32 ? [246, 246, 236] : x === 36 ? [246, 246, 236] : [110, 108, 42];
      px.set([...c, 255], (y * W + x) * 4);
    }
    return px;
  }
  /** The natural-colour picture of the same scene: dark sea, green land, white low and high cloud. */
  function naturalScene(): Uint8ClampedArray {
    const px = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = x < 8 ? [20, 40, 90] : x < 16 ? [70, 120, 60] : x < 32 ? [225, 228, 230] : [70, 120, 60];
      px.set([...c, 255], (y * W + x) * 4);
    }
    return px;
  }
  const at = (out: Uint8ClampedArray, x: number) => Array.from(out.slice((5 * W + x) * 4, (5 * W + x) * 4 + 4));

  it('clears land and sea and keeps the cloud pixels as they are', () => {
    const out = shadeCloudLayer(scene(), W, H, 'hrv', 58, naturalScene());
    expect(at(out, 3)[3]).toBe(0);                      // sea
    expect(at(out, 9)[3]).toBeLessThan(25);             // land (a little of the smoothing reaches it at the cloud's edge)
    const high = at(out, 28);                           // high cloud: its own colour
    expect(Math.abs(high[0] - 246)).toBeLessThan(25);
    expect(Math.abs(high[2] - 236)).toBeLessThan(40);
    expect(high[3]).toBeGreaterThan(220);
  });

  it('shows low (yellow) cloud, found with the natural-colour picture', () => {
    const out = shadeCloudLayer(scene(), W, H, 'hrv', 58, naturalScene());
    const low = at(out, 20);                                    // still yellow, so it reads as low cloud
    expect(Math.abs(low[0] - 214)).toBeLessThan(35);
    expect(low[2]).toBeLessThan(120);
    expect(low[3]).toBeGreaterThan(200);
    const without = shadeCloudLayer(scene(), W, H, 'hrv', 58);  // no natural colour: very bright yellow still counts
    expect(at(without, 20)[3]).toBeGreaterThan(80);
    expect(at(without, 9)[3]).toBeLessThan(25);
  });

  it('smooths the picked cloud and puts its texture back: no hard edge, no dark fringe, the colour code kept', () => {
    const out = shadeCloudLayer(scene(), W, H, 'hrv', 58, naturalScene());
    const alphas = Array.from({ length: W }, (_, x) => at(out, x)[3]);
    let step = 0;
    for (let x = 1; x < W; x++) step = Math.max(step, Math.abs(alphas[x] - alphas[x - 1]));
    expect(step).toBeLessThan(110);                                // the 8-pixel cloud blocks fade over several pixels
    expect(at(out, 24)[0]).toBeGreaterThan(200);                   // where yellow meets white: not darkened towards the cleared neighbours
    expect(at(out, 20)[2]).toBeLessThan(at(out, 28)[2]);          // low cloud still yellower than high cloud
  });

  it('restores texture: a bright core in a wide cloud stays brighter than its surroundings', () => {
    const w = 60, h = 40;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const core = Math.hypot(x - 30, y - 20) < 4;
      px.set(core ? [250, 250, 225, 255] : x > 8 && x < 52 && y > 6 && y < 34 ? [200, 200, 170, 255] : [57, 57, 58, 255], (y * w + x) * 4);
    }
    const out = shadeCloudLayer(px, w, h, 'hrv', 58);
    const at2 = (x: number, y: number) => out[(y * w + x) * 4];
    expect(at2(30, 20)).toBeGreaterThan(at2(18, 20) + 10);
    expect(out[(20 * w + 30) * 4 + 3]).toBeGreaterThan(200);
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

describe('blurField (the fast version) and blurFieldWide', () => {
  /** The plain convolution the fast version replaces: every tap clamped at the edges. */
  function referenceBlur(field: Float32Array, width: number, height: number, sigma: number): Float32Array {
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const kernel = new Float32Array(2 * radius + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += (kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma)));
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    const tmp = new Float32Array(field.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += field[y * width + Math.min(width - 1, Math.max(0, x + k))] * kernel[k + radius];
      tmp[y * width + x] = acc;
    }
    const out = new Float32Array(field.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += tmp[Math.min(height - 1, Math.max(0, y + k)) * width + x] * kernel[k + radius];
      out[y * width + x] = acc;
    }
    return out;
  }

  /** Blobs of cloud with ragged edges, values 0..1, touching the borders. */
  function clouds(w: number, h: number): Float32Array {
    const f = new Float32Array(w * h);
    let s = 11;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const cells = Array.from({ length: 9 }, () => ({ x: rnd() * w, y: rnd() * h, r: 8 + rnd() * 24 }));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0;
      for (const c of cells) v = Math.max(v, 1 - Math.hypot(x - c.x, y - c.y) / c.r);
      f[y * w + x] = Math.max(0, v) > 0.15 ? Math.min(1, Math.max(0, v) + (rnd() - 0.5) * 0.3) : 0;
    }
    return f;
  }

  it('matches the plain convolution to float rounding', () => {
    const w = 90, h = 70;
    const f = clouds(w, h);
    for (const sigma of [0.7, 1.5, 2.5, 5.5]) {
      const a = blurField(f, w, h, sigma);
      const b = referenceBlur(f, w, h, sigma);
      let worst = 0;
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
      expect(worst).toBeLessThan(2e-5);
    }
  });

  it('the half-resolution blur of a wide sigma stays within a percent of the exact one', () => {
    const w = 128, h = 96;
    const f = clouds(w, h);
    for (const sigma of [2.5, 5.5]) {
      const a = blurFieldWide(f, w, h, sigma);
      const b = blurField(f, w, h, sigma);
      let worst = 0;
      let mean = 0;
      for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); worst = Math.max(worst, d); mean += d; }
      expect(worst).toBeLessThan(0.03);
      expect(mean / a.length).toBeLessThan(0.003);
      expect(a.reduce((x, y) => x + y, 0)).toBeCloseTo(b.reduce((x, y) => x + y, 0), -1);   // the total cloud is the same
    }
    // narrow blurs and tiny pictures are done exactly
    expect(blurFieldWide(f, w, h, 1)).toEqual(blurField(f, w, h, 1));
  });
});
