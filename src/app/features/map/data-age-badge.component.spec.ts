import { describe, it, expect } from 'vitest';
import { dataAgeMessage, formatAge } from './data-age-badge.component';

const base = {
  radarOn: false, radarLive: true, radarAgeMin: null, radarAnyShown: true, radarSyncing: false,
  satelliteOn: false, satelliteNewest: true, satelliteAgeMin: null,
};

describe('data age badge', () => {
  it('says nothing while the pictures are fresh', () => {
    expect(dataAgeMessage({ ...base, radarOn: true, radarAgeMin: 20 })).toBeNull();
    expect(dataAgeMessage({ ...base, satelliteOn: true, satelliteAgeMin: 45 })).toBeNull();
  });

  it('flags an old radar scan and a late satellite picture', () => {
    expect(dataAgeMessage({ ...base, radarOn: true, radarAgeMin: 130 })).toBe('Radar: the newest scan is 2 h 10 min old');
    expect(dataAgeMessage({ ...base, satelliteOn: true, satelliteAgeMin: 176 })).toBe('Satellite: the newest picture is 2 h 56 min old (EUMETSAT is running late)');
  });

  it('flags a radar with no picture, but not while it is still loading or when every radar is off', () => {
    expect(dataAgeMessage({ ...base, radarOn: true })).toBe('Radar: no picture from IMD right now');
    expect(dataAgeMessage({ ...base, radarOn: true, radarSyncing: true })).toBeNull();
    expect(dataAgeMessage({ ...base, radarOn: true, radarAnyShown: false })).toBeNull();
  });

  it('only looks at the live picture, not a step of the loop', () => {
    expect(dataAgeMessage({ ...base, radarOn: true, radarLive: false, radarAgeMin: 130 })).toBeNull();
    expect(dataAgeMessage({ ...base, satelliteOn: true, satelliteNewest: false, satelliteAgeMin: 176 })).toBeNull();
  });

  it('writes ages in minutes, then hours and minutes', () => {
    expect(formatAge(45)).toBe('45 min');
    expect(formatAge(120)).toBe('2 h');
    expect(formatAge(185)).toBe('3 h 5 min');
  });
});
