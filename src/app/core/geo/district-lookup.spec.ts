import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAreaIndex, findPlace, pointInPolygon, pointInRing } from './district-lookup';

const square = (x: number, y: number, s: number): [number, number][] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];

describe('point in polygon', () => {
  it('detects inside and outside a ring', () => {
    expect(pointInRing(square(0, 0, 10), 5, 5)).toBe(true);
    expect(pointInRing(square(0, 0, 10), 15, 5)).toBe(false);
  });

  it('treats holes as outside', () => {
    const rings = [square(0, 0, 10), square(4, 4, 2)];
    expect(pointInPolygon(rings, 1, 1)).toBe(true);
    expect(pointInPolygon(rings, 5, 5)).toBe(false);
  });
});

describe('findPlace', () => {
  const collection = {
    features: [
      { properties: { kind: 'state', name: 'Kerala' }, geometry: { type: 'MultiPolygon', coordinates: [[square(70, 8, 10)]] } },
      { properties: { kind: 'district', name: 'Idukki', state: 'Kerala' }, geometry: { type: 'MultiPolygon', coordinates: [[square(70, 8, 4)]] } },
    ],
  };
  const index = buildAreaIndex(collection);

  it('returns the district and state', () => {
    expect(findPlace(index, 9, 71)).toEqual({ district: 'Idukki', state: 'Kerala' });
  });

  it('falls back to the state, then to nothing', () => {
    expect(findPlace(index, 16, 77)).toEqual({ district: null, state: 'Kerala' });
    expect(findPlace(index, 30, 30)).toEqual({ district: null, state: null });
  });
});

describe('real district data', () => {
  const geojson = JSON.parse(readFileSync('public/data/south-india-districts.geojson', 'utf-8'));
  const index = buildAreaIndex(geojson);

  it('covers every South Indian state with districts', () => {
    const states = new Set(index.districts.map(d => d.state));
    expect([...states].sort()).toEqual(['Andhra Pradesh', 'Karnataka', 'Kerala', 'Puducherry', 'Tamil Nadu', 'Telangana']);
    expect(index.districts.filter(d => d.state === 'Tamil Nadu')).toHaveLength(38);
  });

  it.each([
    ['Chennai', 13.08, 80.27, 'Tamil Nadu'],
    ['Madurai', 9.92, 78.12, 'Tamil Nadu'],
    ['Thiruvananthapuram', 8.52, 76.94, 'Kerala'],
    ['Bengaluru', 12.97, 77.59, 'Karnataka'],
    ['Hyderabad', 17.38, 78.48, 'Telangana'],
    ['Visakhapatnam', 17.69, 83.22, 'Andhra Pradesh'],
  ])('puts %s in the right state', (_name, lat, lon, state) => {
    expect(findPlace(index, lat, lon).state).toBe(state);
  });

  it('puts open sea outside every district', () => {
    expect(findPlace(index, 10, 70)).toEqual({ district: null, state: null });
  });
});
