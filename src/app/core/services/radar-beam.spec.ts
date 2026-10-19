import { describe, it, expect } from 'vitest';
import { IMD_RADAR_STATIONS } from '../domain/models/radar.model';
import { ANTENNA_KM, beamHeightKm, beamsOverPlace, groundDistanceKm } from './radar-beam';

describe('radar beam height', () => {
  it('starts at the antenna and climbs with the sweep and the curve of the Earth', () => {
    expect(beamHeightKm(0, 0.5)).toBeCloseTo(ANTENNA_KM, 6);
    // 100 km at 0.5 degrees: 0.87 km of climb plus 0.59 km of Earth curving away (4/3 radius)
    expect(beamHeightKm(100, 0.5)).toBeCloseTo(0.05 + 0.873 + 0.589, 1);
    expect(beamHeightKm(200, 0.5)).toBeGreaterThan(beamHeightKm(100, 0.5) * 2);
  });

  it('gives each radar that reaches a place, nearest first, with the beam between its bottom and top', () => {
    // Kallakurichi: about 133 km from Karaikal and 208 km from Chennai
    const beams = beamsOverPlace(IMD_RADAR_STATIONS, 'caz', 11.74, 78.96);
    expect(beams.map(b => b.stationId)).toEqual(['karaikal', 'chennai']);
    expect(beams[0].distanceKm).toBeCloseTo(133, -1);
    expect(beams[0].centreKm).toBeCloseTo(2.3, 0);
    expect(beams[1].centreKm).toBeCloseTo(4.4, 0);
    for (const b of beams) {
      expect(b.bottomKm).toBeLessThan(b.centreKm);
      expect(b.topKm).toBeGreaterThan(b.centreKm);
    }
  });

  it('leaves out a radar that is turned off or does not reach the place', () => {
    expect(beamsOverPlace(IMD_RADAR_STATIONS, 'caz', 11.74, 78.96, id => id !== 'karaikal').map(b => b.stationId)).toEqual(['chennai']);
    expect(beamsOverPlace(IMD_RADAR_STATIONS, 'caz', 20, 75)).toEqual([]);
    // Bengaluru is about 290 km from Chennai: past its 250 km column-maximum picture
    expect(groundDistanceKm(13.0839, 80.2901, 12.97, 77.59)).toBeGreaterThan(250);
    expect(beamsOverPlace(IMD_RADAR_STATIONS, 'caz', 12.97, 77.59)).toEqual([]);
  });
});
