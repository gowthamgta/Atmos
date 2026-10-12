import { describe, expect, it } from 'vitest';
import {
  METRIC, beaufortFromMs, formatPressure, formatRain, formatTemp, formatWind, legendConversion, msFromBeaufort, niceTicks,
  pressureFromHpa, pressureToHpa, quantityOf, rainFromMm, rainToMm, tempFromC, tempToC, unitChoices, windFromMs, windToMs,
} from './units';

describe('units', () => {
  it('converts temperature both ways', () => {
    expect(tempFromC(0, 'F')).toBe(32);
    expect(tempFromC(100, 'F')).toBe(212);
    expect(tempToC(tempFromC(27.5, 'F'), 'F')).toBeCloseTo(27.5, 9);
    expect(tempFromC(27, 'C')).toBe(27);
  });

  it('converts wind speed to every unit and back', () => {
    expect(windFromMs(10, 'kmh')).toBeCloseTo(36, 6);
    expect(windFromMs(10, 'mph')).toBeCloseTo(22.37, 2);
    expect(windFromMs(10, 'kn')).toBeCloseTo(19.44, 2);
    expect(windFromMs(10, 'ms')).toBe(10);
    for (const u of ['kmh', 'mph', 'kn', 'ms'] as const) expect(windToMs(windFromMs(7.3, u), u)).toBeCloseTo(7.3, 9);
  });

  it('puts wind on the Beaufort scale', () => {
    expect(Math.round(beaufortFromMs(0.2))).toBe(0);      // calm
    expect(Math.round(beaufortFromMs(3.4))).toBe(3);       // gentle breeze
    expect(Math.round(beaufortFromMs(10.8))).toBe(6);      // strong breeze
    expect(Math.round(beaufortFromMs(33))).toBe(12);       // hurricane force, and no higher
    expect(beaufortFromMs(100)).toBe(12);
    expect(beaufortFromMs(msFromBeaufort(5))).toBeCloseTo(5, 9);
  });

  it('converts rain and pressure', () => {
    expect(rainFromMm(25.4, 'in')).toBeCloseTo(1, 9);
    expect(rainToMm(rainFromMm(7, 'in'), 'in')).toBeCloseTo(7, 9);
    expect(pressureFromHpa(1013.25, 'inHg')).toBeCloseTo(29.92, 2);
    expect(pressureFromHpa(1013.25, 'mmHg')).toBeCloseTo(760, 0);
    expect(pressureToHpa(pressureFromHpa(1000, 'inHg'), 'inHg')).toBeCloseTo(1000, 6);
  });

  it('formats values with their unit, and a dash for a missing one', () => {
    const f = { ...METRIC, temp: 'F' as const, wind: 'kn' as const, rain: 'in' as const, pressure: 'inHg' as const };
    expect(formatTemp(30, METRIC)).toBe('30°C');
    expect(formatTemp(30, f)).toBe('86°F');
    expect(formatTemp(30, f, 0, false)).toBe('86°');
    expect(formatWind(10, METRIC)).toBe('36 km/h');
    expect(formatWind(10, f)).toBe('19 kn');
    expect(formatWind(10, { ...METRIC, wind: 'bft' })).toBe('Bft 5');
    expect(formatRain(12.7, f)).toBe('0.50 in');          // inches need two decimals below 1
    expect(formatRain(50.8, f)).toBe('2.0 in');
    expect(formatRain(0.5, METRIC, true)).toBe('0.5 mm/h');
    expect(formatPressure(1012, f)).toBe('29.88 inHg');
    expect(formatTemp(NaN, METRIC)).toBe('–');
    expect(formatWind(null, METRIC)).toBe('–');
  });

  it('knows which quantity a layer shows, and not for a layer aloft', () => {
    expect(quantityOf('temp', '°C')).toBe('temp');
    expect(quantityOf('wind', 'km/h')).toBe('wind');
    expect(quantityOf('rain', 'mm/h')).toBe('rainRate');
    expect(quantityOf('raintot', 'mm in the chosen period')).toBe('rain');
    expect(quantityOf('pressure', 'hPa')).toBe('pressure');
    expect(quantityOf('pressure', 'dam')).toBeNull();      // heights of a pressure level, not a pressure
    expect(quantityOf('humidity', '%')).toBeNull();
    expect(unitChoices('wind').map(c => c.label)).toEqual(['km/h', 'm/s', 'mph', 'kn', 'bft']);
  });

  it('works out legend values in the chosen unit and back', () => {
    const wind = legendConversion('wind', { ...METRIC, wind: 'kn' });
    expect(wind.label).toBe('kn');
    expect(wind.from(36)).toBeCloseTo(19.44, 2);           // the legend is drawn in km/h
    expect(wind.to(wind.from(50))).toBeCloseTo(50, 6);
    expect(legendConversion('rainRate', { ...METRIC, rain: 'in' }).label).toBe('in/h');
  });

  it('picks round ticks in a range', () => {
    expect(niceTicks(65, 110, 5)).toEqual([70, 80, 90, 100, 110]);
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(0, 12, 6, true)).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(niceTicks(5, 5)).toEqual([]);
  });
});
