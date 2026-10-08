import { describe, expect, it } from 'vitest';
import { maxPixelRatio, radarMosaicMaxPx, satelliteImageSize } from './device-profile';

describe('device profile', () => {
  it('asks a phone for fewer satellite pixels than a desktop, but enough to stay sharp (about 3 km per pixel)', () => {
    const phone = satelliteImageSize(true);
    const full = satelliteImageSize(false);
    expect(phone.width * phone.height).toBeLessThan(full.width * full.height);
    expect(phone.width).toBeGreaterThanOrEqual(1000);
    expect(phone.width / phone.height).toBeCloseTo(full.width / full.height, 1);
  });

  it('draws a phone screen at up to twice the pixels, a desktop at its native ratio', () => {
    expect(maxPixelRatio(true, 3)).toBe(2);
    expect(maxPixelRatio(true, 1.5)).toBe(1.5);
    expect(maxPixelRatio(false, 3)).toBe(3);
  });

  it('keeps the radar mosaic smaller on a phone, but never below the stations\' own 0.5 km grid in range', () => {
    expect(radarMosaicMaxPx(true)).toBeLessThan(radarMosaicMaxPx(false));
    expect(radarMosaicMaxPx(true)).toBeGreaterThanOrEqual(1024);
  });
});
