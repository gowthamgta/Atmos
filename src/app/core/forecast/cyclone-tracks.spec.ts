import { describe, expect, it } from 'vitest';
import { CycloneData, cycloneGeoJson, windClass } from './cyclone-tracks';

const data: CycloneData = {
  version: 1,
  run: '20261007T12Z',
  storms: [{
    id: '03B', name: 'TEST', basin: 'Bay of Bengal',
    track: [
      { h: 0, lat: 14, lon: 88, pMsl: 1000, wind: 18 },
      { h: 6, lat: 14.5, lon: 87.5, pMsl: 996, wind: 25 },
      { h: 24, lat: 16, lon: 85, pMsl: 985, wind: 36 },
    ],
    members: [[[0, 14, 88], [12, 15, 86]], [[0, 14, 88]]],
  }],
};

describe('cyclone tracks', () => {
  it('classes a storm by its 10 m wind', () => {
    expect(windClass(10).name).toBe('Low');
    expect(windClass(20).name).toBe('Depression');
    expect(windClass(36).name).toBe('Cyclonic storm');
    expect(windClass(70).name).toBe('Very severe or stronger');
    expect(windClass(null).name).toBe('Low');
  });

  it('draws the main track, the member spread and a labelled point per time', () => {
    const fc = cycloneGeoJson(data);
    const kinds = fc.features.map(f => f.properties?.['kind']);
    expect(kinds.filter(k => k === 'track').length).toBe(1);
    expect(kinds.filter(k => k === 'member').length).toBe(1);        // a one-point member is not a line
    const points = fc.features.filter(f => f.properties?.['kind'] === 'point');
    expect(points.map(p => p.properties?.['label'])).toEqual(['TEST 03B', '', '+1 d · 985 hPa']);
    expect((fc.features.find(f => f.properties?.['kind'] === 'track')!.geometry as { coordinates: number[][] }).coordinates[0]).toEqual([88, 14]);
  });

  it('is empty when there is no data or no storm', () => {
    expect(cycloneGeoJson(null).features).toEqual([]);
    expect(cycloneGeoJson({ ...data, storms: [] }).features).toEqual([]);
  });
});
