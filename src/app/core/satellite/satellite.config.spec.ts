import { describe, expect, it } from 'vitest';
import { SATELLITE_HRV, SATELLITE_IR, productForTime, sunElevationDeg } from './satellite.config';

const T = (iso: string) => Date.parse(iso);

describe('sunElevationDeg and productForTime', () => {
  it('has the sun high at local noon and well below the horizon at local midnight over South India', () => {
    // local solar noon at 79 E is about 06:45 UTC
    expect(sunElevationDeg(T('2026-10-05T06:45:00Z'), 13, 79)).toBeGreaterThan(65);
    expect(sunElevationDeg(T('2026-10-04T18:45:00Z'), 13, 79)).toBeLessThan(-55);
  });

  it('matches the equinox geometry (noon sun on the equator is overhead in March)', () => {
    expect(sunElevationDeg(T('2026-03-20T12:00:00Z'), 0, 0)).toBeGreaterThan(87);
  });

  it('uses HRV in daylight and infrared at night, in Indian time', () => {
    expect(productForTime(T('2026-10-05T05:30:00Z'))).toBe(SATELLITE_HRV); // 11:00 IST
    expect(productForTime(T('2026-10-05T20:00:00Z'))).toBe(SATELLITE_IR); // 01:30 IST
    expect(productForTime(T('2026-10-05T14:00:00Z'))).toBe(SATELLITE_IR); // 19:30 IST, dark
  });

  it('switches to HRV after sunrise and back to infrared by evening', () => {
    // in early October the sun rises near 06:00 IST (00:30 UTC) and sets near 18:00 IST (12:30 UTC)
    expect(productForTime(T('2026-10-05T00:00:00Z'))).toBe(SATELLITE_IR); // 05:30 IST
    expect(productForTime(T('2026-10-05T02:00:00Z'))).toBe(SATELLITE_HRV); // 07:30 IST
    expect(productForTime(T('2026-10-05T11:00:00Z'))).toBe(SATELLITE_HRV); // 16:30 IST
    expect(productForTime(T('2026-10-05T13:00:00Z'))).toBe(SATELLITE_IR); // 18:30 IST
  });
});
