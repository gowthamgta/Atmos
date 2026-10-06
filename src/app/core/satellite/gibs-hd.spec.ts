import { describe, expect, it } from 'vitest';
import { GIBS_SENSORS, NO_DATA_MAX_SUM, blackToTransparent, gibsDate, gibsTemplate, gibsTileUrl, isEmptyTile, parseGibsUrl } from './gibs-hd';
import {
  HIMAWARI_IR,
  HIMAWARI_PROBE_STEPS,
  HIMAWARI_VIS,
  SATELLITE_SOURCES,
  himawariCandidates,
  himawariProbeUrl,
  productForTime,
  satelliteFrameUrl,
} from './satellite.config';
import { brightenVisible, cloudCover, shadePixel } from './satellite-image';

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

describe('Himawari-9 from GIBS', () => {
  it('takes a picture every 10 minutes, seven of them for the last hour', () => {
    const s = SATELLITE_SOURCES.himawari;
    expect(s.stepMin).toBe(10);
    expect((s.frameCount - 1) * s.stepMin).toBe(60);
    expect(SATELLITE_SOURCES.meteosat.frameCount).toBe(5);
  });

  it('uses the visible band in daylight over South India and the infrared at night', () => {
    expect(productForTime(T('2026-10-06T06:00:00Z'), 'himawari')).toBe(HIMAWARI_VIS);   // 11:30 IST
    expect(productForTime(T('2026-10-06T17:00:00Z'), 'himawari')).toBe(HIMAWARI_IR);    // 22:30 IST
    expect(productForTime(T('2026-10-06T06:00:00Z')).source).toBe('meteosat');
  });

  it('asks GIBS for the region as a latitude/longitude picture at the given time', () => {
    const url = new URL(satelliteFrameUrl(HIMAWARI_IR, T('2026-10-06T05:10:00Z')));
    expect(url.origin + url.pathname).toBe('https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi');
    expect(url.searchParams.get('LAYERS')).toBe('Himawari_AHI_Band13_Clean_Infrared');
    expect(url.searchParams.get('TIME')).toBe('2026-10-06T05:10:00Z');
    expect(url.searchParams.get('BBOX')).toBe('4,68,22,90');   // south, west, north, east for EPSG:4326 in WMS 1.3.0
    expect(url.searchParams.get('FORMAT')).toBe('image/jpeg');
  });

  it('probes with a tiny transparent picture, newest candidate first, on the 10-minute grid', () => {
    const probe = new URL(himawariProbeUrl(HIMAWARI_VIS, T('2026-10-06T04:50:00Z')));
    expect(probe.searchParams.get('TRANSPARENT')).toBe('true');
    expect(Number(probe.searchParams.get('WIDTH')) * Number(probe.searchParams.get('HEIGHT'))).toBeLessThan(5000);
    const c = himawariCandidates(T('2026-10-06T05:56:00Z'));
    expect(c).toHaveLength(HIMAWARI_PROBE_STEPS);
    expect(c[0]).toBe(T('2026-10-06T05:30:00Z'));
    for (let i = 1; i < c.length; i++) expect(c[i - 1] - c[i]).toBe(10 * 60_000);
  });
});

describe('Himawari visible picture', () => {
  it('is lifted so a dark grey picture has contrast', () => {
    const px = new Uint8ClampedArray([20, 20, 20, 255, 200, 200, 200, 255]);
    brightenVisible(px);
    expect(px[0]).toBeGreaterThan(60);
    expect(px[4]).toBeGreaterThan(235);
    expect(px[3]).toBe(255);
  });

  it('shows bright cloud over a darker background in the cloud view and keeps the picture in the full view', () => {
    const src = new Uint8ClampedArray([80, 80, 80, 255, 230, 230, 230, 255]);
    const cover = cloudCover(src, 2, 1, 'vis', 80);
    expect(cover[0]).toBe(0);
    expect(cover[1]).toBe(1);
    const out = new Uint8ClampedArray(4);
    shadePixel('vis', 'picture', 120, 120, 120, 80, out, 0);
    expect(Array.from(out.slice(0, 3))).toEqual([120, 120, 120]);
    expect(out[3]).toBeGreaterThan(200);
  });
});
