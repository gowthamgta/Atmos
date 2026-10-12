import { describe, expect, it } from 'vitest';
import { currentIcon, istMidnight, outlookIcon, temperatureBar, temperatureColor } from './outlook';

describe('outlook strip', () => {
  it('finds the IST midnight at or before a time', () => {
    const midnight = Date.UTC(2026, 9, 11, 18, 30);          // 00:00 on 12 Oct in India
    expect(istMidnight(midnight)).toBe(midnight);
    expect(istMidnight(midnight + 5 * 3_600_000)).toBe(midnight);
    expect(istMidnight(midnight - 1)).toBe(midnight - 86_400_000);
  });

  it('chooses the picture of a day by its rain first, then its cloud', () => {
    expect(outlookIcon(40, 10)).toBe('rain24');       // heavy rain, whatever the cloud
    expect(outlookIcon(5, 90)).toBe('rain');
    expect(outlookIcon(0.2, 85)).toBe('cloud');
    expect(outlookIcon(0, 45)).toBe('partly');
    expect(outlookIcon(0, 5)).toBe('sun');
    expect(outlookIcon(null, null)).toBe('sun');       // nothing known: a plain day
    expect(outlookIcon(null, 80)).toBe('cloud');
  });

  it('draws the sky now: rain first, then cloud, a moon at night', () => {
    const noon = Date.UTC(2026, 9, 12, 6, 30);               // 12:00 IST
    const night = Date.UTC(2026, 9, 12, 20, 30);             // 02:00 IST on the 13th
    expect(currentIcon(6, 20, noon)).toBe('rain24');
    expect(currentIcon(1, 20, noon)).toBe('rain');
    expect(currentIcon(0, 90, night)).toBe('cloud');
    expect(currentIcon(0, 40, noon)).toBe('partly');
    expect(currentIcon(0, 5, noon)).toBe('sun');
    expect(currentIcon(0, 5, night)).toBe('moon');
    expect(currentIcon(null, null, noon)).toBe('sun');
  });

  it('colours a temperature from the temperature palette and clamps outside its range', () => {
    expect(temperatureColor(0)).toBe(temperatureColor(18));       // colder than the scale: its coldest colour
    expect(temperatureColor(60)).toBe(temperatureColor(42));      // hotter: its hottest
    expect(temperatureColor(42)).toBe('rgb(138, 42, 10)');        // the dark red end of windy's temperature scale
    expect(temperatureColor(30)).not.toBe(temperatureColor(20));
  });

  it('draws the bar from the low to the high, and nothing when neither is known', () => {
    expect(temperatureBar(22, 33)).toBe(`linear-gradient(to right, ${temperatureColor(22)}, ${temperatureColor(33)})`);
    expect(temperatureBar(null, 33)).toBe(`linear-gradient(to right, ${temperatureColor(33)}, ${temperatureColor(33)})`);
    expect(temperatureBar(null, null)).toBe('transparent');
  });
});
