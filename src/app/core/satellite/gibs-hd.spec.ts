import { describe, expect, it } from 'vitest';
import { GIBS_SENSORS, NO_DATA_MAX_SUM, blackToTransparent, gibsDate, gibsTemplate, gibsTileUrl, isEmptyTile, parseGibsUrl } from './gibs-hd';

const T = (iso: string) => Date.parse(iso);

describe('GIBS high-detail tiles', () => {
  it('lists the instruments, each with its own layer', () => {
    expect(new Set(GIBS_SENSORS.map(s => s.id)).size).toBe(GIBS_SENSORS.length);
    for (const s of GIBS_SENSORS) expect(s.layer).toMatch(/CorrectedReflectance_TrueColor$/);
  });

  it('writes the UTC date of a day offset', () => {
    expect(gibsDate(T('2026-10-06T00:30:00Z'), 0)).toBe('2026-10-06');
    expect(gibsDate(T('2026-10-06T00:30:00Z'), 1)).toBe('2026-10-05');
    expect(gibsDate(T('2026-10-01T23:59:00Z'), 2)).toBe('2026-09-29');
  });

  it('builds the real tile address (row before column) and round-trips the map template', () => {
    expect(gibsTileUrl('MODIS_Terra_CorrectedReflectance_TrueColor', '2026-10-05', 9, 366, 237)).toBe(
      'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2026-10-05/GoogleMapsCompatible_Level9/9/237/366.jpg');
    const template = gibsTemplate('VIIRS_SNPP_CorrectedReflectance_TrueColor', '2026-10-05');
    expect(parseGibsUrl(template.replace('{z}', '7').replace('{x}', '91').replace('{y}', '59'))).toEqual(
      { layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', date: '2026-10-05', z: 7, x: 91, y: 59 });
    expect(parseGibsUrl('https://example.com/x')).toBeNull();
  });

  it('makes no-data black see-through and keeps dark sea', () => {
    const px = new Uint8ClampedArray([0, 0, 0, 255, 2, 3, 2, 255, 10, 24, 48, 255, 90, 120, 160, 255]);
    blackToTransparent(px);
    expect(px[3]).toBe(0);                 // black
    expect(px[7]).toBe(0);                 // near black
    expect(px[11]).toBe(255);              // dark blue sea
    expect(px[15]).toBe(255);
    const edge = new Uint8ClampedArray([NO_DATA_MAX_SUM / 3 + 4, 4, 4, 255]);
    blackToTransparent(edge);
    expect(edge[3]).toBeGreaterThan(0);
    expect(edge[3]).toBeLessThan(255);
  });

  it('knows an all-black tile from one with a picture', () => {
    expect(isEmptyTile(new Uint8ClampedArray(4 * 100))).toBe(true);
    const lit = new Uint8ClampedArray(4 * 100);
    for (let i = 0; i < 100; i += 2) { lit[i * 4] = 80; lit[i * 4 + 1] = 100; lit[i * 4 + 2] = 120; }
    expect(isEmptyTile(lit)).toBe(false);
  });
});
