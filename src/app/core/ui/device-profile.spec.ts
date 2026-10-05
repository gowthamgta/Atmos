import { describe, expect, it } from 'vitest';
import { radarMosaicMaxPx, satelliteImageSize } from './device-profile';

describe('device profile', () => {
  it('asks a phone for a quarter of the satellite pixels, with the same shape', () => {
    const phone = satelliteImageSize(true);
    const full = satelliteImageSize(false);
    expect(phone.width * phone.height).toBeLessThanOrEqual((full.width * full.height) / 3.9);
    expect(phone.width / phone.height).toBeCloseTo(full.width / full.height, 1);
  });

  it('keeps the radar mosaic smaller on a phone, but never below the stations\' own 0.5 km grid in range', () => {
    expect(radarMosaicMaxPx(true)).toBeLessThan(radarMosaicMaxPx(false));
    expect(radarMosaicMaxPx(true)).toBeGreaterThanOrEqual(1024);
  });
});
