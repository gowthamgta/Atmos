import { describe, expect, it } from 'vitest';
import { bestMs } from '../testing/bench';
import { blurPlane, enhancePicture, gaussianKernel, smoothChannel, smoothGrey } from './satellite-enhance';

/** A small repeatable random generator (the tests must not depend on luck). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
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

describe('smoothGrey and smoothChannel', () => {
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
  // the energy of the jumps between neighbours (a step of height d is d squared; the same rise spread over six pixels is a sixth of it)
  const jumps = (a: Uint8ClampedArray, channel = 0) => {
    let sum = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) sum += (a[(y * w + x) * 4 + channel] - a[(y * w + x - 1) * 4 + channel]) ** 2;
    }
    return sum;
  };

  it('takes the steps out: the jumps between neighbouring pixels shrink to a fraction of what they were', () => {
    const px = picture();
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

describe('enhancePicture', () => {
  const w = 1000; // a picture this wide (a phone's) is smoothed by 0.7 pixels
  const h = 24;
  const rand = lcg(4);
  const noise = Array.from({ length: w * h }, () => Math.floor(rand() * 255));

  it('smooths the infrared as grey', () => {
    const px = rgba(w, h, i => noise[i], i => noise[i], i => noise[i]);
    const copy = Uint8ClampedArray.from(px);
    enhancePicture(px, w, h, 'ir');
    expect(px).not.toEqual(copy);
    expect(px[4 + 1]).toBe(px[4]);
    expect(px[4 + 2]).toBe(px[4]);
  });

  it('leaves the sharp red and green of the HRV picture alone and smooths only its infrared blue', () => {
    const px = rgba(w, h, i => noise[i], i => noise[(i * 7) % noise.length], i => noise[(i * 13) % noise.length]);
    const copy = Uint8ClampedArray.from(px);
    enhancePicture(px, w, h, 'hrv');
    for (let i = 0; i < w * h; i++) {
      expect(px[i * 4]).toBe(copy[i * 4]);
      expect(px[i * 4 + 1]).toBe(copy[i * 4 + 1]);
    }
    expect(px.filter((_, i) => i % 4 === 2)).not.toEqual(copy.filter((_, i) => i % 4 === 2));
  });

  it('blurs by the ground it covers: a finer picture (a closer window) is blurred more pixels, a coarser one fewer', () => {
    const base = rgba(w, h, i => noise[i], i => noise[i], i => noise[i]);
    const roughness = (a: Uint8ClampedArray) => {
      let sum = 0;
      for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) sum += (a[(y * w + x) * 4] - a[(y * w + x - 1) * 4]) ** 2;
      return sum;
    };
    const coarse = Uint8ClampedArray.from(base);
    const fine = Uint8ClampedArray.from(base);
    enhancePicture(coarse, w, h, 'ir', 0.5);
    enhancePicture(fine, w, h, 'ir', 2);
    expect(roughness(fine)).toBeLessThan(roughness(coarse));
  });

  it('keeps pace: a full 2000 pixel picture is tidied in well under a few seconds', () => {
    const W = 2000;
    const make = () => rgba(W, W, i => 30 + (i % 190), i => 30 + (i % 190), () => 50);
    const hrvMs = bestMs(1, 1, () => enhancePicture(make(), W, W, 'hrv'));
    const irMs = bestMs(1, 1, () => enhancePicture(make(), W, W, 'ir'));
    // both include making the picture, so only the order of magnitude counts
    expect(hrvMs).toBeLessThan(3000);
    expect(irMs).toBeLessThan(3000);
  });
});
