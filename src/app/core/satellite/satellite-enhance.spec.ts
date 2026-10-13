import { describe, expect, it } from 'vitest';
import { bestMs } from '../testing/bench';
import {
  DEFAULT_SHIFT,
  blurPlane,
  boxBlurPlane,
  enhancePicture,
  estimateShift,
  gaussianKernel,
  sharpenColourWithHrv,
  smoothChannel,
  smoothGrey,
} from './satellite-enhance';

/** A small repeatable random generator (the tests must not depend on luck). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A textured plane: random values blurred a little, spread over `lo`..`hi`. */
function texture(width: number, height: number, seed: number, lo = 40, hi = 200, radius = 2): Float32Array {
  const rand = lcg(seed);
  const plane = new Float32Array(width * height);
  for (let i = 0; i < plane.length; i++) plane[i] = rand();
  boxBlurPlane(plane, width, height, radius);
  let min = Infinity;
  let max = -Infinity;
  for (const v of plane) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  for (let i = 0; i < plane.length; i++) plane[i] = lo + ((plane[i] - min) / (max - min)) * (hi - lo);
  return plane;
}

/** Bilinear read of a plane at a fractional position (pixel centres on whole numbers; the ends repeat). */
function sample(plane: Float32Array, width: number, height: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number) => plane[Math.min(Math.max(yy, 0), height - 1) * width + Math.min(Math.max(xx, 0), width - 1)];
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

function rgba(width: number, height: number, r: (i: number) => number, g: (i: number) => number, b: (i: number) => number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    px[i * 4] = r(i);
    px[i * 4 + 1] = g(i);
    px[i * 4 + 2] = b(i);
    px[i * 4 + 3] = 255;
  }
  return px;
}

describe('gaussianKernel and blurPlane', () => {
  it('has weights that add up to one, are symmetric and reach three sigma', () => {
    const k = gaussianKernel(1.5);
    expect(k.length).toBe(2 * Math.ceil(4.5) + 1);
    expect(k.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 5);
    for (let i = 0; i < k.length; i++) expect(k[i]).toBeCloseTo(k[k.length - 1 - i], 6);
  });

  it('leaves a flat plane flat, edges included', () => {
    const plane = new Float32Array(30 * 20).fill(77);
    blurPlane(plane, 30, 20, 2);
    for (const v of plane) expect(v).toBeCloseTo(77, 3);
  });

  it('spreads a point without losing any of it', () => {
    const plane = new Float32Array(41 * 41);
    plane[20 * 41 + 20] = 1000;
    blurPlane(plane, 41, 41, 1.5);
    expect(plane.reduce((a, v) => a + v, 0)).toBeCloseTo(1000, 1);
    expect(plane[20 * 41 + 20]).toBeLessThan(200);
    expect(plane[20 * 41 + 20]).toBeGreaterThan(plane[20 * 41 + 23]);
    expect(plane[20 * 41 + 21]).toBeCloseTo(plane[21 * 41 + 20], 3);
  });
});

describe('boxBlurPlane', () => {
  it('is the plain average of the square around each pixel, the edges repeating', () => {
    const w = 23;
    const h = 17;
    const src = texture(w, h, 7, 0, 255, 1);
    const blurred = Float32Array.from(src);
    boxBlurPlane(blurred, w, h, 3);
    const brute = (x: number, y: number): number => {
      let sum = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          sum += src[Math.min(Math.max(y + dy, 0), h - 1) * w + Math.min(Math.max(x + dx, 0), w - 1)];
        }
      }
      return sum / 49;
    };
    for (const [x, y] of [[0, 0], [w - 1, h - 1], [11, 8], [2, 14], [20, 1]]) {
      expect(blurred[y * w + x]).toBeCloseTo(brute(x, y), 2);
    }
  });
});

describe('smoothGrey', () => {
  // an infrared picture as the service draws it: 4-pixel steps of random grey
  const w = 96;
  const h = 96;
  const steps = new Float32Array(w * h);
  {
    const rand = lcg(3);
    const cells = Array.from({ length: 24 * 24 }, () => 20 + Math.floor(rand() * 200));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) steps[y * w + x] = cells[Math.floor(y / 4) * 24 + Math.floor(x / 4)];
  }
  const picture = () => rgba(w, h, i => steps[i], i => steps[i], i => steps[i]);

  it('takes the steps out: the jumps between neighbouring pixels shrink to a fraction of what they were', () => {
    const px = picture();
    // the energy of the jumps (a step of height d is d squared; the same rise spread over six pixels is a sixth of it)
    const jumps = (a: Uint8ClampedArray) => {
      let sum = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 1; x < w; x++) sum += (a[(y * w + x) * 4] - a[(y * w + x - 1) * 4]) ** 2;
      }
      return sum;
    };
    const before = jumps(px);
    smoothGrey(px, w, h, 1.5);
    expect(jumps(px)).toBeLessThan(before * 0.4);
  });

  it('keeps the average brightness, the three channels equal and the alpha as it was', () => {
    const px = picture();
    const mean = (a: Uint8ClampedArray) => {
      let sum = 0;
      for (let i = 0; i < w * h; i++) sum += a[i * 4];
      return sum / (w * h);
    };
    const before = mean(px);
    px[3] = 0; // one see-through pixel
    smoothGrey(px, w, h, 1.5);
    expect(Math.abs(mean(px) - before)).toBeLessThan(1.5);
    for (let i = 0; i < w * h; i++) {
      expect(px[i * 4 + 1]).toBe(px[i * 4]);
      expect(px[i * 4 + 2]).toBe(px[i * 4]);
    }
    expect(px[3]).toBe(0);
    expect(px[7]).toBe(255);
  });

  it('keeps a big flat black area black, so empty parts of the picture stay see-through', () => {
    const px = rgba(64, 64, () => 0, () => 0, () => 0);
    smoothGrey(px, 64, 64, 1.5);
    expect(px.every((v, i) => i % 4 === 3 || v === 0)).toBe(true);
  });

  it('smooths one channel only with smoothChannel', () => {
    const px = picture();
    const red = px.filter((_, i) => i % 4 === 0);
    smoothChannel(px, w, h, 2, 1.5);
    expect(px.filter((_, i) => i % 4 === 0)).toEqual(red);
    expect(px.filter((_, i) => i % 4 === 2)).not.toEqual(red);
  });
});

describe('estimateShift', () => {
  const w = 140;
  const h = 130;
  const base = texture(w, h, 11);
  const all = new Uint8Array(w * h).fill(1);
  /** `base` moved right by dx and down by dy (bilinear). */
  const moved = (dx: number, dy: number) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = sample(base, w, h, x - dx, y - dy);
    return out;
  };

  it('finds a whole-pixel move', () => {
    const found = estimateShift(moved(2, -1), base, all, w, h)!;
    expect(found).not.toBeNull();
    expect(found.x).toBeCloseTo(2, 1);
    expect(found.y).toBeCloseTo(-1, 1);
    expect(found.score).toBeGreaterThan(0.9);
  });

  it('finds a move of a fraction of a pixel', () => {
    const found = estimateShift(moved(0.7, -0.4), base, all, w, h)!;
    expect(found.x).toBeCloseTo(0.7, 0);
    expect(Math.abs(found.x - 0.7)).toBeLessThan(0.25);
    expect(Math.abs(found.y + 0.4)).toBeLessThan(0.25);
  });

  it('says nothing when there is no texture to go by, or no valid pixels', () => {
    const flat = new Float32Array(w * h).fill(100);
    expect(estimateShift(flat, base, all, w, h)).toBeNull();
    expect(estimateShift(base, base, new Uint8Array(w * h), w, h)).toBeNull();
  });

  it('says nothing when the pictures are not of the same thing', () => {
    expect(estimateShift(texture(w, h, 99), base, all, w, h)).toBeNull();
  });

  it('says nothing when the move lies beyond the search', () => {
    expect(estimateShift(moved(6, 0), base, all, w, h)).toBeNull();
  });
});

describe('sharpenColourWithHrv', () => {
  const W = 256;
  const C = 128;

  it('puts the HRV detail into a plain colour and keeps its hue', () => {
    const detail = texture(W, W, 5, 60, 190, 1);
    const hrv = rgba(W, W, i => detail[i], i => detail[i], () => 30);
    const colour = rgba(C, C, () => 60, () => 120, () => 40);
    const info = sharpenColourWithHrv(hrv, W, W, colour, C, C);
    expect(info.measured).toBe(false); // a plain colour has no texture to line up against
    expect(info.shiftX).toBeCloseTo(DEFAULT_SHIFT.x * (W / 2000), 5);
    let n = 0;
    let sum = 0;
    let sum2 = 0;
    let cross = 0;
    let dsum = 0;
    let dsum2 = 0;
    for (let y = 20; y < W - 20; y++) {
      for (let x = 20; x < W - 20; x++) {
        const i = y * W + x;
        const g = hrv[i * 4 + 1];
        // hue kept: green is twice red, blue two thirds of red (where nothing clipped)
        if (g > 20 && g < 240) {
          expect(Math.abs(g / hrv[i * 4] - 2)).toBeLessThan(0.15);
        }
        n++;
        sum += g;
        sum2 += g * g;
        cross += g * detail[i];
        dsum += detail[i];
        dsum2 += detail[i] * detail[i];
      }
    }
    const variance = sum2 / n - (sum / n) ** 2;
    expect(variance).toBeGreaterThan(20); // the plain colour (variance 0) now has texture
    const corr = (cross / n - (sum / n) * (dsum / n)) / Math.sqrt(variance * (dsum2 / n - (dsum / n) ** 2));
    expect(corr).toBeGreaterThan(0.5); // and it is the HRV's
    expect(hrv[3]).toBe(255);
  });

  it('leaves the colour as it is where the HRV has no data, and fades the detail in at the edge of its data', () => {
    const detail = texture(W, W, 6, 60, 190, 1);
    const hole = (i: number) => i % W < 100; // no HRV for the left 100 columns
    const hrv = rgba(W, W, i => (hole(i) ? 0 : detail[i]), i => (hole(i) ? 0 : detail[i]), i => (hole(i) ? 140 : 30));
    const colour = rgba(C, C, () => 60, () => 120, () => 40);
    sharpenColourWithHrv(hrv, W, W, colour, C, C);
    for (let y = 10; y < W - 10; y++) {
      for (let x = 0; x < 90; x++) {
        const i = (y * W + x) * 4;
        expect([hrv[i], hrv[i + 1], hrv[i + 2]]).toEqual([60, 120, 40]);
      }
    }
  });

  it('does not make black (no data) of anything real, and keeps empty colour pixels empty', () => {
    const hrv = rgba(W, W, () => 2, () => 2, () => 2); // almost black everywhere, but real
    const colour = rgba(C, C, i => (i % C < 20 ? 0 : 3), i => (i % C < 20 ? 0 : 3), i => (i % C < 20 ? 0 : 3));
    sharpenColourWithHrv(hrv, W, W, colour, C, C);
    expect(hrv[(100 * W + 5) * 4]).toBe(0);
    expect(hrv[(100 * W + 5) * 4 + 1]).toBe(0);
    for (let x = 60; x < W; x += 7) {
      const i = (100 * W + x) * 4;
      expect(hrv[i]).toBeGreaterThanOrEqual(1);
      expect(hrv[i + 1]).toBeGreaterThanOrEqual(1);
      expect(hrv[i + 2]).toBeGreaterThanOrEqual(1);
    }
  });

  it('measures how far the colour picture lies from the HRV and moves it into line', () => {
    // a colour picture with texture; the HRV is the same scene a pixel and a half to the right and one up
    const coarse = texture(C, C, 21, 40, 220, 2);
    const sx = 1.5;
    const sy = -1;
    const detail = new Float32Array(W * W);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) detail[y * W + x] = sample(coarse, C, C, (x + 0.5 - sx) / 2 - 0.5, (y + 0.5 - sy) / 2 - 0.5);
    }
    const hrv = rgba(W, W, i => detail[i], i => detail[i], () => 30);
    const colour = rgba(C, C, i => coarse[i], i => coarse[i], i => coarse[i]);
    const info = sharpenColourWithHrv(hrv, W, W, colour, C, C);
    expect(info.measured).toBe(true);
    expect(Math.abs(info.shiftX - sx)).toBeLessThan(0.5);
    expect(Math.abs(info.shiftY - sy)).toBeLessThan(0.5);
  });

  it('copes with a colour picture the same size as the main one, and with odd sizes', () => {
    const w = 90;
    const h = 70;
    const detail = texture(w, h, 8, 60, 190, 1);
    const hrv = rgba(w, h, i => detail[i], i => detail[i], () => 30);
    const colour = rgba(w, h, () => 80, () => 90, () => 100);
    expect(() => sharpenColourWithHrv(hrv, w, h, colour, w, h)).not.toThrow();
    const small = rgba(37, 29, () => 80, () => 90, () => 100);
    expect(() => sharpenColourWithHrv(rgba(w, h, i => detail[i], i => detail[i], () => 30), w, h, small, 37, 29)).not.toThrow();
  });
});

describe('enhancePicture', () => {
  it('smooths infrared and water vapour as grey', () => {
    const w = 1000; // a picture this wide (a phone's) is smoothed by 0.75 pixels
    const h = 24;
    const rand = lcg(2);
    const px = rgba(w, h, () => 0, () => 0, () => 0);
    for (let i = 0; i < w * h; i++) px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = Math.floor(rand() * 255);
    const copy = Uint8ClampedArray.from(px);
    enhancePicture(px, w, h, 'ir');
    expect(px).not.toEqual(copy);
    expect(px[4 + 1]).toBe(px[4]);
    const wv = Uint8ClampedArray.from(copy);
    enhancePicture(wv, w, h, 'wv');
    expect(wv).toEqual(px);
  });

  it('without a colour picture, only the infrared blue of the HRV picture is smoothed', () => {
    const w = 40;
    const h = 40;
    const rand = lcg(4);
    const px = rgba(w, h, () => 100, () => 110, () => 0);
    for (let i = 0; i < w * h; i++) px[i * 4 + 2] = Math.floor(rand() * 255);
    enhancePicture(px, w, h, 'hrv');
    for (let i = 0; i < w * h; i++) {
      expect(px[i * 4]).toBe(100);
      expect(px[i * 4 + 1]).toBe(110);
    }
  });

  it('keeps pace: a full 2000 pixel picture is done in a few seconds', () => {
    const W = 2000;
    const C = 1000;
    const detail = texture(W, W, 1, 30, 220, 1);
    const hrv = () => rgba(W, W, i => detail[i], i => detail[i], () => 50);
    const colour = rgba(C, C, i => 40 + (i % 97), i => 80 + (i % 53), i => 60 + (i % 31));
    // both timings include making the picture, so only the order of magnitude counts
    const colourMs = bestMs(1, 1, () => enhancePicture(hrv(), W, W, 'hrv', { data: colour, width: C, height: C }));
    const greyMs = bestMs(1, 1, () => enhancePicture(hrv(), W, W, 'ir'));
    expect(colourMs).toBeLessThan(6000);
    expect(greyMs).toBeLessThan(3000);
  });
});
