import { describe, expect, it } from 'vitest';
import { maxPixelRatio, radarMosaicMaxPx, weakHardware } from './device-profile';

describe('device profile', () => {
  it('draws a phone screen at up to twice the pixels, a desktop at its native ratio', () => {
    expect(maxPixelRatio(true, 3)).toBe(2);
    expect(maxPixelRatio(true, 1.5)).toBe(1.5);
    expect(maxPixelRatio(false, 3)).toBe(3);
  });

  it('keeps the radar mosaic smaller on a phone, but never below the stations\' own 0.5 km grid in range', () => {
    expect(radarMosaicMaxPx(true)).toBeLessThan(radarMosaicMaxPx(false));
    expect(radarMosaicMaxPx(true)).toBeGreaterThanOrEqual(1024);
  });

  it('takes a device for weak from what the browser says: 2 cores or fewer, 2 GB or less, a software GPU', () => {
    expect(weakHardware(8, 8, 'ANGLE (Qualcomm, Adreno (TM) 619)')).toBe(false);   // a mid-range phone: judged by its frame rate instead
    expect(weakHardware(2, 8, 'Intel UHD')).toBe(true);
    expect(weakHardware(8, 2, 'Intel UHD')).toBe(true);
    expect(weakHardware(8, 8, 'Google SwiftShader')).toBe(true);
    expect(weakHardware(8, 8, 'llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(weakHardware(undefined, undefined, '')).toBe(false);                   // nothing known: not weak on hints alone
  });
});
