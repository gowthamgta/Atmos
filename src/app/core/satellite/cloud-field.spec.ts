import { describe, expect, it } from 'vitest';
import { buildCloudField, cloudColumn, readColumn, tauFromReflectance, tauFromTop } from './cloud-field';
import { mercatorHeight } from './satellite-image';

describe('cloud field', () => {
  it('takes optical thickness from brightness: dim cloud is thin, bright cloud thick', () => {
    expect(tauFromReflectance(0)).toBe(0);
    expect(tauFromReflectance(0.5)).toBeCloseTo(7.7, 5);
    expect(tauFromReflectance(0.85)).toBeGreaterThan(40);
    expect(tauFromReflectance(0.99)).toBeLessThanOrEqual(80);
  });

  it('puts each kind of cloud between its base and its top', () => {
    // a warm low top: cumulus with its base at the condensation level
    const cu = cloudColumn(1, 14, 15);
    expect(cu.topKm).toBeGreaterThan(2);
    expect(cu.topKm).toBeLessThan(3);
    expect(cu.baseKm).toBeCloseTo(1, 5);
    // a cold, thick top: a cumulonimbus from 1 km to near the tropopause
    const cb = cloudColumn(1, -75, 60);
    expect(cb.topKm).toBeGreaterThan(16);
    expect(cb.baseKm).toBeCloseTo(1, 5);
    // a cold but thin top: cirrus, a layer under its top
    const ci = cloudColumn(1, -45, 2);
    expect(ci.topKm - ci.baseKm).toBeCloseTo(1.8, 5);
    // a middle top, thin: altocumulus
    const ac = cloudColumn(1, 0, 8);
    expect(ac.topKm - ac.baseKm).toBeCloseTo(1.2, 5);
    expect(tauFromTop(16, -70)).toBeGreaterThan(tauFromTop(10, -40));
  });

  it('builds a field from an infrared picture: cloud where it is colder than the ground', () => {
    const width = 64;
    const height = 64;
    const src = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const x = i % width;
      const v = x < 32 ? 60 : 230; // warm ground on the left, a cold top on the right
      src.set([v, v, v, 255], i * 4);
    }
    const outHeight = mercatorHeight(width);
    const field = buildCloudField(src, width, height, 'ir', outHeight, null, 0);
    const y = Math.floor(field.h / 2);
    const clear = readColumn(field, 5, y);
    const storm = readColumn(field, field.w - 5, y);
    expect(clear.cover).toBe(0);
    expect(storm.cover).toBeGreaterThan(0.9);
    expect(storm.topKm).toBeGreaterThan(14); // luma 0.9: about -74 C
    expect(storm.baseKm).toBeLessThan(1.5); // thick: a storm standing on the condensation level
  });

  it('takes the top from the measured brightness temperatures when they are there', () => {
    const width = 64;
    const height = 64;
    const src = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) src.set([150, 150, 150, 255], i * 4); // a mid grey everywhere: about -38 C by the assumed scale
    const outHeight = mercatorHeight(width);
    // measured: warm ground (295 K) on the left, a -70 C top (203 K) on the right
    const bt = { w: 32, h: 32, data: new Uint8ClampedArray(32 * 32 * 4), offsetK: 180, stepK: 0.5 };
    for (let i = 0; i < 32 * 32; i++) bt.data[i * 4] = i % 32 < 16 ? (295 - 180) / 0.5 : (203 - 180) / 0.5;
    const field = buildCloudField(src, width, height, 'ir', outHeight, null, 0, bt);
    const y = Math.floor(field.h / 2);
    expect(readColumn(field, 5, y).cover).toBe(0); // as warm as the ground: clear, whatever the grey says
    const storm = readColumn(field, field.w - 5, y);
    expect(storm.cover).toBeGreaterThan(0.9);
    expect(storm.topKm).toBeGreaterThan(15);
  });

  it('by day takes the cover from the overlay and the thickness from the visible brightness', () => {
    const width = 64;
    const height = 64;
    const src = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const x = i % width;
      // left: bright, warm low cloud; right: dim, cold high cloud (cirrus)
      if (x < 32) src.set([220, 220, 90, 255], i * 4);
      else src.set([70, 70, 230, 255], i * 4);
    }
    const outHeight = mercatorHeight(width);
    const cover = new Uint8Array(width * outHeight).fill(255);
    const field = buildCloudField(src, width, height, 'hrv', outHeight, cover, 60);
    const y = Math.floor(field.h / 2);
    const low = readColumn(field, 5, y);
    const high = readColumn(field, field.w - 5, y);
    expect(low.topKm).toBeLessThan(high.topKm);
    expect(low.tau).toBeGreaterThan(high.tau);
    expect(high.baseKm).toBeGreaterThan(6); // thin and high: a cirrus layer, not a tower
  });
});
