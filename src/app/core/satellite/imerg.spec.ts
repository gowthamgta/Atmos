import { describe, expect, it } from 'vitest';
import { IMERG_SLOT_MS, imergCandidates, imergLabelIst, imergSlot, imergTemplate, imergTimeParam, imergTileUrl } from './imerg';

describe('IMERG observed rain', () => {
  const t = Date.UTC(2026, 9, 7, 21, 47, 12);

  it('rounds a time down to its half hour and writes the GIBS time parameter', () => {
    expect(imergTimeParam(imergSlot(t))).toBe('2026-10-07T21:30:00Z');
    expect(imergSlot(Date.UTC(2026, 9, 7, 22, 0, 0))).toBe(Date.UTC(2026, 9, 7, 22, 0, 0));
  });

  it('builds the tile addresses for the 30-minute layer', () => {
    const slot = imergSlot(t);
    expect(imergTileUrl(slot, 4, 11, 7)).toBe('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate_30min/default/2026-10-07T21:30:00Z/GoogleMapsCompatible_Level6/4/7/11.png');
    expect(imergTemplate(slot)).toContain('/{z}/{y}/{x}.png');
  });

  it('tries slots from the expected latency backwards, half an hour apart', () => {
    const c = imergCandidates(t);
    expect(c.length).toBe(16);
    expect(c[0] - c[1]).toBe(IMERG_SLOT_MS);
    expect(c[0]).toBeLessThan(t - 2 * 3_600_000);
  });

  it('labels a slot in Indian time', () => {
    expect(imergLabelIst(Date.UTC(2026, 9, 7, 21, 30))).toBe('8 Oct, 03:00');
  });
});
