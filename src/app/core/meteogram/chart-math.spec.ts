import { describe, expect, it } from 'vitest';
import {
  areaPath, bandPath, barsPath, daySpans, everyNth, hourAtX, istDayStart, istHour12, linePath, linear, niceScale, niceStep, nightSpans, sunTimes,
} from './chart-math';

const H = 3_600_000;

describe('scales with round ticks', () => {
  it('chooses a step of 1, 2 or 5 times a power of ten', () => {
    expect(niceStep(10, 5)).toBe(2);
    expect(niceStep(7, 5)).toBe(1);
    expect(niceStep(100, 4)).toBe(20);
    expect(niceStep(0.9, 4)).toBe(0.2);
    expect(niceStep(0, 4)).toBeGreaterThan(0);       // a flat series does not divide by zero
  });

  it('covers the values and starts and ends on a tick', () => {
    const s = niceScale(23.4, 33.1, { count: 4 });
    expect(s.ticks[0]).toBeLessThanOrEqual(23.4);
    expect(s.ticks.at(-1)!).toBeGreaterThanOrEqual(33.1);
    expect(s.min).toBe(s.ticks[0]);
    expect(s.max).toBe(s.ticks.at(-1));
    expect(s.ticks.every(t => Math.abs(t / s.step - Math.round(t / s.step)) < 1e-9)).toBe(true);
  });

  it('starts rain and wind at zero and gives a dry day a visible height', () => {
    const rain = niceScale(0, 0.4, { zeroBased: true, minSpan: 2 });
    expect(rain.min).toBe(0);
    expect(rain.max).toBeGreaterThanOrEqual(2);
    expect(niceScale(5, 30, { zeroBased: true }).min).toBe(0);
  });

  it('widens a flat temperature so a degree is not stretched to the whole height', () => {
    const s = niceScale(30.1, 30.3, { minSpan: 4 });
    expect(s.max - s.min).toBeGreaterThanOrEqual(4);
    expect(s.min).toBeLessThan(30.1);
    expect(s.max).toBeGreaterThan(30.3);
  });

  it('keeps ticks whole for a unit that is counted (Beaufort)', () => {
    const s = niceScale(0, 7, { zeroBased: true, integer: true, count: 8 });
    expect(s.ticks.every(Number.isInteger)).toBe(true);
  });

  it('has no float noise or negative zero in its ticks', () => {
    for (const t of niceScale(-0.3, 0.9, { count: 5 }).ticks) expect(Object.is(t, -0)).toBe(false);
    expect(niceScale(0, 1, { count: 5 }).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
});

describe('lines', () => {
  const pts = (ys: (number | null)[]) => ys.map((y, i) => ({ x: i * 10, y }));

  it('draws nothing for nothing, and breaks the line where a model has no value', () => {
    expect(linePath([])).toBe('');
    expect(linePath(pts([null, null]))).toBe('');
    const broken = linePath(pts([5, 6, null, 7, 8]), false);
    expect(broken).toBe('M0 5L10 6M30 7L40 8');
  });

  it('draws a smooth line through every point', () => {
    const d = linePath(pts([0, 10, 5, 20]));
    expect(d.startsWith('M0 0')).toBe(true);
    expect(d.endsWith('30 20')).toBe(true);
    expect((d.match(/C/g) ?? []).length).toBe(3);
  });

  it('never overshoots its points (a peak stays a peak)', () => {
    // control points of the monotone curve stay between the neighbouring values
    const d = linePath(pts([10, 10, 30, 30]));
    const nums = [...d.matchAll(/-?\d+(\.\d+)?/g)].map(m => Number(m[0]));
    const ys = nums.filter((_, i) => i % 2 === 1);          // y of each pair
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(Math.max(...ys)).toBeLessThanOrEqual(30 + 1e-6);
  });

  it('draws a single point as a start only, and two points straight', () => {
    expect(linePath(pts([4]))).toBe('M0 4');
    expect(linePath(pts([4, 6]))).toBe('M0 4L10 6');
  });

  it('closes an area down to a baseline for each unbroken stretch', () => {
    const d = areaPath(pts([5, 6, null, 7, 8]), 100, false);
    expect(d).toBe('M0 5L10 6L10 100L0 100ZM30 7L40 8L40 100L30 100Z');
    expect(areaPath(pts([5, null, 7]), 100)).toBe('');         // single points are not areas
  });

  it('fills the band between a gust line and a wind line', () => {
    const upper = pts([10, 12, 14]);
    const lower = pts([4, 5, 6]);
    expect(bandPath(upper, lower, false)).toBe('M0 10L10 12L20 14L20 6L10 5L0 4Z');
    expect(bandPath(pts([10, null, 14]), lower, false)).toBe('');
  });
});

describe('rain bars', () => {
  it('stands each bar on the baseline, as one path', () => {
    const d = barsPath([{ x: 10, y: 80 }, { x: 20, y: 60 }], 100, 6);
    expect(d).toBe('M7 100V80H13V100ZM17 100V60H23V100Z');
  });

  it('skips dry hours and gaps, and keeps a trace of rain as a hairline', () => {
    expect(barsPath([{ x: 10, y: 100 }, { x: 20, y: null }], 100, 6)).toBe('');
    const trace = barsPath([{ x: 10, y: 99.9 }], 100, 6, 1.5);
    expect(trace).toBe('M7 100V98.5H13V100Z');
  });
});

describe('scale mapping', () => {
  it('maps a domain onto a range, upside down for a chart', () => {
    const y = linear(0, 10, 100, 0);
    expect(y(0)).toBe(100);
    expect(y(10)).toBe(0);
    expect(y(2.5)).toBe(75);
    expect(linear(5, 5, 0, 10)(5)).toBe(0);                     // an empty domain does not divide by zero
  });
});

describe('days and nights', () => {
  it('finds the IST day a time is in', () => {
    const midnight = Date.UTC(2026, 9, 11, 18, 30);
    expect(istDayStart(midnight + 7 * H)).toBe(midnight);
    expect(istDayStart(midnight - 1)).toBe(midnight - 24 * H);
  });

  it('cuts the days of a window at its ends', () => {
    const start = Date.UTC(2026, 9, 11, 18, 30) + 6 * H;      // 06:00 IST on 12 Oct
    const spans = daySpans(start, start + 30 * H);
    expect(spans).toHaveLength(2);
    expect(spans[0].fromMs).toBe(start);
    expect(spans[0].toMs).toBe(Date.UTC(2026, 9, 12, 18, 30));
    expect(spans[1].toMs).toBe(start + 30 * H);
  });

  it('puts the sun up at about 06:00 and down at about 18:00 IST at Kallakurichi in October', () => {
    // reference (timeanddate): 12 Oct 2026 Kallakurichi sunrise 06:00, sunset 17:55 IST
    const t = sunTimes(11.74, 78.96, Date.UTC(2026, 9, 12, 6, 30))!;
    const ist = (ms: number) => new Date(ms + 5.5 * H);
    const minutes = (ms: number) => ist(ms).getUTCHours() * 60 + ist(ms).getUTCMinutes();
    expect(Math.abs(minutes(t.sunrise) - 6 * 60)).toBeLessThanOrEqual(8);
    expect(Math.abs(minutes(t.sunset) - (17 * 60 + 55))).toBeLessThanOrEqual(8);
    expect(t.sunset).toBeGreaterThan(t.sunrise);
  });

  it('has a longer day in the north in June than in December (further from the equator)', () => {
    const length = (month: number) => {
      const t = sunTimes(28.6, 77.2, Date.UTC(2026, month, 21, 6))!;      // Delhi
      return (t.sunset - t.sunrise) / H;
    };
    expect(length(5)).toBeGreaterThan(13.5);
    expect(length(11)).toBeLessThan(10.8);
  });

  it('lists the nights of a window, cut at its ends', () => {
    const start = Date.UTC(2026, 9, 12, 0, 0);                  // 05:30 IST: before sunrise
    const nights = nightSpans(11.74, 78.96, start, start + 48 * H);
    expect(nights.length).toBe(3);                              // the end of the night under way, a whole night, and the start of the next
    expect(nights[0].fromMs).toBe(start);
    expect(nights[0].toMs - nights[0].fromMs).toBeLessThan(2 * H);
    expect(nights[1].toMs - nights[1].fromMs).toBeGreaterThan(11 * H);
    expect(nights[1].toMs - nights[1].fromMs).toBeLessThan(13 * H);
    expect(nights[2].toMs).toBe(start + 48 * H);                // cut at the end of the window
  });
});

describe('reading the chart', () => {
  it('finds the hour under the pointer, and stays inside the series', () => {
    expect(hourAtX(0, 0, 100, 11)).toBe(0);
    expect(hourAtX(50, 0, 100, 11)).toBe(5);
    expect(hourAtX(99, 0, 100, 11)).toBe(10);
    expect(hourAtX(-30, 0, 100, 11)).toBe(0);
    expect(hourAtX(400, 0, 100, 11)).toBe(10);
    expect(hourAtX(5, 0, 100, 1)).toBe(0);
  });

  it('thins out labels so they keep their distance', () => {
    expect(everyNth(20, 20)).toBe(1);
    expect(everyNth(5, 20)).toBe(6);                              // 4 px an hour: every 6 hours is 30 px apart (3 is 15)
    expect(everyNth(1, 20)).toBe(24);
    expect(everyNth(0.1, 20)).toBe(24);                           // never more thinned out than a day
  });

  it('writes an hour as on the time bar', () => {
    expect(istHour12(Date.UTC(2026, 9, 11, 18, 30))).toBe('12 AM');
    expect(istHour12(Date.UTC(2026, 9, 12, 0, 30))).toBe('6 AM');
    expect(istHour12(Date.UTC(2026, 9, 12, 6, 30))).toBe('12 PM');
    expect(istHour12(Date.UTC(2026, 9, 12, 9, 30))).toBe('3 PM');
  });
});
