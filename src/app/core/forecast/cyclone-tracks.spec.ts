import { describe, expect, it } from 'vitest';
import { CONE_HOURS, CycloneData, coneOutline, coneRadiusKm, cycloneGeoJson, runStartMs, smoothTrack, stormAt, windClass } from './cyclone-tracks';

const RUN = Date.UTC(2026, 9, 7, 12);
const data: CycloneData = {
  version: 1,
  run: '20261007T12Z',
  storms: [{
    id: '03B', name: 'TEST', basin: 'Bay of Bengal',
    track: [
      { h: 0, lat: 14, lon: 88, pMsl: 1000, wind: 12 },
      { h: 12, lat: 14.5, lon: 87, pMsl: 996, wind: 20 },
      { h: 24, lat: 15, lon: 86, pMsl: 985, wind: 30 },
      { h: 36, lat: 15.5, lon: 85, pMsl: 975, wind: 40 },
      { h: 48, lat: 16, lon: 84, pMsl: 965, wind: 50 },
    ],
    members: [],
  }],
};
const of = (kind: string, t: number | null = null) => cycloneGeoJson(data, t).features.filter(f => f.properties['kind'] === kind);

describe('cyclone tracks', () => {
  it('classes a storm by its wind as IMD does', () => {
    expect(windClass(5).short).toBe('L');
    expect(windClass(10).name).toBe('Depression');
    expect(windClass(16).name).toBe('Deep depression');
    expect(windClass(20).name).toBe('Cyclonic storm');        // 39 kt: a cyclonic storm, not a depression
    expect(windClass(30).short).toBe('SCS');
    expect(windClass(40).short).toBe('VSCS');
    expect(windClass(50).short).toBe('ESCS');
    expect(windClass(70).name).toBe('Super cyclonic storm');
    expect(windClass(null).short).toBe('L');
  });

  it('draws the track in legs coloured by the stronger end, a point every 12 h and a label each day', () => {
    const legs = of('segment');
    expect(legs.length).toBe(4);
    expect(legs[0].properties['color']).toBe(windClass(20).color);
    const labels = of('point').map(p => p.properties['label']).filter(Boolean);
    expect(labels).toEqual(['Thu 8\n108 km/h SCS', 'Fri 9\n180 km/h ESCS']); // the days in India time, the wind and the class
  });

  it('puts the storm at the time on the bar, between its forecast positions', () => {
    const now = of('now', RUN + 6 * 3_600_000);
    expect(now.length).toBe(1);
    expect(now[0].geometry).toEqual({ type: 'Point', coordinates: [87.5, 14.25] });
    expect(String(now[0].properties['label'])).toMatch(/^TEST \(03B\)\nDeep depression · 58 km\/h · 998 hPa$/); // 16 m/s halfway between 12 and 20
    expect(of('now', RUN - 3_600_000)).toEqual([]); // before the track
    expect(of('now', null)).toEqual([]); // no time on the bar
    // the legs it has passed are drawn faded
    expect(of('segment', RUN + 30 * 3_600_000).map(s => s.properties['past'])).toEqual([true, true, false, false]);
  });

  it('draws one cone outline that grows along the track and ends at five days', () => {
    expect(coneRadiusKm(0)).toBe(20);
    expect(coneRadiusKm(24)).toBe(72);
    expect(coneRadiusKm(30)).toBeCloseTo(85, 0);
    const rings = coneOutline(data.storms[0].track);
    expect(rings.length).toBe(1); // a single polygon: no seams where pieces would overlap
    const ring = rings[0][0];
    const lons = ring.map(p => p[0]);
    // reaches past the last position by about its radius (120 km at 48 h, a little more than 1 degree of longitude)
    expect(Math.min(...lons)).toBeLessThan(84 - 1);
    expect(Math.max(...lons)).toBeLessThan(88.5);
    const long: CycloneData = { ...data, storms: [{ ...data.storms[0], track: [...data.storms[0].track, { h: 200, lat: 20, lon: 80, pMsl: 990, wind: 20 }] }] };
    const cone = cycloneGeoJson(long, RUN).features.find(f => f.properties['kind'] === 'cone')!;
    const all = (cone.geometry as { coordinates: number[][][][] }).coordinates.flat(2);
    expect(Math.min(...all.map(p => p[0]))).toBeGreaterThan(82); // the position at 200 h, beyond CONE_HOURS, is not in it
    expect(CONE_HOURS).toBe(120);
  });

  it('smooths the wobble of the track for drawing, keeping its ends', () => {
    const t = [
      { h: 0, lat: 10, lon: 80, pMsl: null, wind: null },
      { h: 6, lat: 11, lon: 82, pMsl: null, wind: null },
      { h: 12, lat: 10, lon: 80, pMsl: null, wind: null },
    ];
    const s = smoothTrack(t);
    expect(s[0]).toEqual(t[0]);
    expect(s[2]).toEqual(t[2]);
    expect(s[1].lat).toBeCloseTo(10.5, 6);
    expect(stormAt(t, 3)!.lon).toBeCloseTo(81, 6);
    expect(runStartMs('20261007T12Z')).toBe(RUN);
    expect(runStartMs('nonsense')).toBeNull();
  });

  it('is empty when there is no data or no storm', () => {
    expect(cycloneGeoJson(null).features).toEqual([]);
    expect(cycloneGeoJson({ ...data, storms: [] }).features).toEqual([]);
  });
});
