import { describe, it, expect } from 'vitest';
import { IMD_RADAR_STATIONS } from '../domain/models/radar.model';
import { ALOFT_MIN_OPACITY, ANTENNA_KM, aloftOpacity, beamHeightKm, beamsOverPlace, groundDistanceKm, isRainAloft, lowestBeamHeights, withAloftFade } from './radar-beam';

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

describe('rain aloft', () => {
  const dbz = (d: number) => (d - 12) / 9.6;

  it('draws a faint echo seen only from high up see-through, never hidden, and leaves strong or low echoes solid', () => {
    expect(aloftOpacity(dbz(20), 4.4)).toBeCloseTo(ALOFT_MIN_OPACITY, 2); // faint, beam 4.4 km up (Chennai over Kallakurichi)
    expect(aloftOpacity(dbz(20), 4.4)).toBeGreaterThan(0);
    expect(aloftOpacity(dbz(20), 1.0)).toBe(1); // faint but near a radar
    expect(aloftOpacity(dbz(40), 4.4)).toBe(1); // a strong core far away
    expect(isRainAloft(20, 4.4)).toBe(true);
    expect(isRainAloft(45, 4.4)).toBe(false);
  });

  it('fades only the faint echoes under a high beam, keeping the fade already there', () => {
    const field = new Float32Array([dbz(20), dbz(20), dbz(45), 0]);
    const heights = new Float32Array([1, 4.4, 4.4, 4.4]);
    const fade = withAloftFade(field, heights, new Uint8Array([255, 200, 255, 255]))!;
    expect([...fade]).toEqual([255, Math.round(200 * ALOFT_MIN_OPACITY), 255, 255]);
    expect(withAloftFade(new Float32Array([dbz(45)]), new Float32Array([4.4]))).toBeUndefined(); // nothing to fade: no fade made
  });

  it('takes the lowest beam of the radars that reach each pixel', () => {
    // a 3 x 3 grid around Kallakurichi: the nearer Karaikal beam (about 2.3 km) is the lowest everywhere
    const corners: [number, number][] = [[78.9, 11.8], [79.0, 11.8], [79.0, 11.7], [78.9, 11.7]];
    const h = lowestBeamHeights(IMD_RADAR_STATIONS, 'caz', corners, 3, 3);
    for (const v of h) expect(v).toBeCloseTo(2.3, 0);
    // far outside both radars: no beam
    const none = lowestBeamHeights(IMD_RADAR_STATIONS, 'caz', [[70, 20], [70.1, 20], [70.1, 19.9], [70, 19.9]], 2, 2);
    expect([...none].every(v => v === Infinity)).toBe(true);
  });
});
