import { describe, expect, it } from 'vitest';
import { altitudeLabels, altitudeSubline, flightLevel, isaHeightM, roundedMetres } from './altitude';
import { LEVEL_KM, PRESSURE_LEVELS } from './forecast-layers';

describe('the standard-atmosphere height of a pressure level', () => {
  it('matches the ICAO table (metres) at every level the app offers', () => {
    const table: Record<number, number> = { 1013.25: 0, 925: 762, 850: 1457, 800: 1949, 700: 3012, 600: 4206, 500: 5574, 300: 9164, 250: 10363, 200: 11784 };
    for (const [p, h] of Object.entries(table)) expect(isaHeightM(Number(p)), `${p} hPa`).toBeCloseTo(h, -0.5); // within about 1.5 m
  });

  it('has no jump where the stratosphere begins (11 km, 226.32 hPa)', () => {
    expect(isaHeightM(226.3206)).toBeCloseTo(11000, -0.5);
    expect(Math.abs(isaHeightM(226.3706) - isaHeightM(226.2706))).toBeLessThan(3);   // a tenth of a hPa is about 3 m up there
  });

  it('only ever rises as the pressure falls', () => {
    let last = -1;
    for (const p of [1000, 925, 850, 800, 700, 600, 500, 400, 300, 250, 226, 200, 150, 100]) {
      const h = isaHeightM(p);
      expect(h).toBeGreaterThan(last);
      last = h;
    }
  });
});

describe('the labels of an altitude', () => {
  it('reproduces windy.com\'s example, 600 hPa as "4200 m" and "FL140"', () => {
    expect(roundedMetres(600)).toBe(4200);
    expect(flightLevel(600)).toBe(140);
  });

  it('gives the pressure, the height in metres and the flight level of each level', () => {
    const rows = PRESSURE_LEVELS.map(l => [l, altitudeLabels(l).metres, altitudeLabels(l).flight]);
    expect(rows).toEqual([
      [925, '800 m', 'FL25'],
      [850, '1500 m', 'FL50'],
      [800, '2000 m', 'FL65'],
      [700, '3000 m', 'FL100'],
      [600, '4200 m', 'FL140'],
      [500, '5600 m', 'FL185'],
      [300, '9200 m', 'FL300'],
      [250, '10400 m', 'FL340'],
      [200, '11800 m', 'FL385'],
    ]);
  });

  it('names the ground without a flight level', () => {
    expect(altitudeLabels('surface')).toEqual({ name: 'Ground', metres: '2–10 m', flight: null });
    expect(altitudeSubline('surface')).toBe('2–10 m');
  });

  it('writes the pressure with a fixed space, so a narrow button never breaks "700 hPa" across two lines', () => {
    expect(altitudeLabels(700).name).toBe('700 hPa');
    expect(altitudeSubline(700)).toBe('3000 m · FL100');
  });

  it('keeps flight levels in 500 ft steps, rising with height', () => {
    const levels = PRESSURE_LEVELS.map(flightLevel);   // from 925 hPa up to 200 hPa
    for (const fl of levels) expect(fl % 5).toBe(0);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });
});

describe('the height table used elsewhere in the app', () => {
  it('agrees with the standard atmosphere to the 100 m it quotes (km to one decimal)', () => {
    for (const l of PRESSURE_LEVELS) expect(LEVEL_KM[l], `${l} hPa`).toBeCloseTo(roundedMetres(l) / 1000, 6);
  });
});
