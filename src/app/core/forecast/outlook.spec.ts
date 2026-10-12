import { describe, expect, it } from 'vitest';
import type { PointSeries } from '../meteogram/point-series';
import { currentIcon, istMidnight, outlookFromSeries, outlookIcon, temperatureBar, temperatureColor } from './outlook';

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

describe('the outlook from the hourly point forecast', () => {
  const H = 3_600_000;
  const DAY = 24 * H;
  const IST_MIDNIGHT = Date.UTC(2026, 9, 11, 18, 30);                 // 00:00 on 12 Oct in India
  const NOW = IST_MIDNIGHT + 10 * H;                                    // 10:00 IST on the 12th

  /** Hourly points on the UTC hours (which are half past in India) from the IST midnight of 11 Oct for `days` days. */
  function series(days: number, pick: (hourOfRun: number, istHour: number) => { temp?: number | null; rain?: number | null; cloud?: number | null }): PointSeries {
    const n = days * 24;
    const times = Array.from({ length: n }, (_, i) => IST_MIDNIGHT - DAY + 30 * 60_000 + i * H);   // the day before, whole
    const m = { temp: [] as (number | null)[], rain: [] as (number | null)[], cloud: [] as (number | null)[] };
    times.forEach((t, i) => {
      const istHour = new Date(t + 5.5 * H).getUTCHours();
      const v = pick(i, istHour);
      m.temp.push(v.temp ?? null);
      m.rain.push(v.rain ?? null);
      m.cloud.push(v.cloud ?? null);
    });
    const empty = times.map(() => null);
    return { lat: 11.74, lon: 78.96, elevationM: 129, times, models: { ecmwf_ifs: { ...m, feels: empty, humidity: empty, wind: empty, windDir: empty, gust: empty, pressure: empty } } };
  }

  it('takes the highest and lowest temperature, the rain and the daytime cloud of each IST day', () => {
    // temperature swings from 24 °C at 05:30 to 34 °C at 15:30; 0.5 mm of rain in each of 4 hours; cloud 80 % by day, 10 % at night
    const s = series(7, (_, ist) => ({ temp: 29 + 5 * Math.sin(((ist - 9.5) / 24) * 2 * Math.PI), rain: ist >= 14 && ist < 18 ? 0.5 : 0, cloud: ist >= 6 && ist < 18 ? 80 : 10 }));
    // the series may not have a full day per rain hour test; each day has 24 hourly values
    const days = outlookFromSeries(s, 'ecmwf_ifs', NOW, 5);
    expect(days).toHaveLength(5);
    expect(days[0].startMs).toBe(IST_MIDNIGHT);
    expect(days[0].weekday).toBe('MON');
    expect(days[0].tmax!).toBeCloseTo(34, 0);
    expect(days[0].tmin!).toBeCloseTo(24, 0);
    expect(days[0].rainMm).toBeCloseTo(2, 5);
    expect(days[0].cloud).toBe(80);                                // the mean over the daylight hours only
    expect(days[0].icon).toBe('rain');                             // 2 mm: rain first
    expect(days[4].weekday).toBe('FRI');
  });

  it('leaves out a day the run does not cover whole, and a model that is not in the answer', () => {
    // the run ends 30 hours after the start of the 12th: the 13th has 6 hours, so it is not a day
    const s = series(3, (i, ist) => ({ temp: i < 24 + 30 ? 30 : null, rain: 0, cloud: 50 }));
    const days = outlookFromSeries(s, 'ecmwf_ifs', NOW, 5);
    expect(days.map(d => d.weekday)).toEqual(['MON']);
    expect(outlookFromSeries(s, 'nope', NOW)).toEqual([]);
  });

  it('shows no rain total when the model has not got the rain of the whole day', () => {
    const s = series(3, () => ({ temp: 30, rain: null, cloud: 90 }));
    const [day] = outlookFromSeries(s, 'ecmwf_ifs', NOW, 1);
    expect(day.rainMm).toBeNull();
    expect(day.icon).toBe('cloud');                                // no rain known: the cloud decides
  });
});
