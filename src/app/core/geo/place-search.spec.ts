import { describe, expect, it } from 'vitest';
import { parseGeocoding, rankPlaces } from './place-search.service';

describe('place search', () => {
  it('reads the places of the geocoding answer', () => {
    const places = parseGeocoding({
      results: [
        { name: 'Salem', latitude: 11.65, longitude: 78.16, admin1: 'Tamil Nadu', admin2: 'Salem' },
        { name: 'Kallakurichi', latitude: 11.73, longitude: 78.96, admin1: 'Tamil Nadu', admin2: 'Kallakurichi' },
      ],
    });
    expect(places).toEqual([
      { name: 'Salem', region: 'Tamil Nadu', lat: 11.65, lon: 78.16 },                 // the district is the town itself: not repeated
      { name: 'Kallakurichi', region: 'Tamil Nadu', lat: 11.73, lon: 78.96 },
    ]);
  });

  it('keeps places of one name apart by their region, and drops repeats and entries without a position', () => {
    const places = parseGeocoding({
      results: [
        { name: 'Aranthangi', latitude: 10.17, longitude: 79.0, admin1: 'Tamil Nadu', admin2: 'Pudukkottai' },
        { name: 'Aranthangi', latitude: 10.17, longitude: 79.0, admin1: 'Tamil Nadu', admin2: 'Pudukkottai' },   // the same place twice
        { name: 'Aranthangi', latitude: 16.4, longitude: 80.1, admin1: 'Andhra Pradesh', admin2: 'Guntur' },
        { name: 'No position' },
        { latitude: 1, longitude: 2 },
      ],
    });
    expect(places.map(p => p.region)).toEqual(['Pudukkottai, Tamil Nadu', 'Guntur, Andhra Pradesh']);
  });

  it('ranks big places first, an exact name over the rest, and nearer places first when that is equal', () => {
    const from = { lat: 11.74, lon: 78.96 };
    const city = { name: 'Madurai', region: 'Tamil Nadu', lat: 9.92, lon: 78.12, population: 1_470_000 };
    const hamletNear = { name: 'Maduraipakkam', region: 'Villupuram', lat: 11.9, lon: 79.8 };
    const hamletSame = { name: 'Madurai', region: 'Chengalpattu', lat: 12.5, lon: 79.9 };
    const hamletFar = { name: 'Madurai Kotha', region: 'Odisha', lat: 20.3, lon: 85.8 };
    expect(rankPlaces([hamletFar, hamletNear, hamletSame, city], 'madurai', from).map(p => p.region)).toEqual(['Tamil Nadu', 'Chengalpattu', 'Villupuram', 'Odisha']);
    const himachal = { name: 'Sal', region: 'Himachal Pradesh', lat: 31.1, lon: 77.2 };
    const salem = { name: 'Salem', region: 'Tamil Nadu', lat: 11.65, lon: 78.16, population: 830_000 };
    expect(rankPlaces([himachal, salem], 'Sal', from).map(p => p.name)).toEqual(['Salem', 'Sal']);   // an exact hamlet does not beat a city
  });

  it('keeps the population the service gives', () => {
    expect(parseGeocoding({ results: [{ name: 'Salem', latitude: 11.6, longitude: 78.1, population: 830000 }] })[0].population).toBe(830000);
  });

  it('stops at the limit and copes with an answer that has no results', () => {
    const many = { results: Array.from({ length: 20 }, (_, i) => ({ name: `P${i}`, latitude: i, longitude: i })) };
    expect(parseGeocoding(many, 5)).toHaveLength(5);
    expect(parseGeocoding({})).toEqual([]);
    expect(parseGeocoding(null)).toEqual([]);
  });
});
