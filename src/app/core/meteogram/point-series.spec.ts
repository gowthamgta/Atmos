import { describe, expect, it } from 'vitest';
import {
  ApiModel, API_VARS, cumulative, extent, firstIndex, indexAt, lastIndex, parsePointSeries, seriesUrl, spreadOf, sumFrom, windowIndexes,
} from './point-series';

const MODELS: ApiModel[] = [
  { id: 'ecmwf_ifs', apiId: 'ecmwf_ifs' },
  { id: 'ukmo', apiId: 'ukmo_global_deterministic_10km' },
  { id: 'aigfs', apiId: 'ncep_aigfs025' },
];

/** An answer shaped like Open-Meteo's, for 6 hours from 00:00 UTC on 12 Oct 2026. */
function answer(): unknown {
  const t0 = Date.UTC(2026, 9, 12) / 1000;
  const time = Array.from({ length: 6 }, (_, i) => t0 + i * 3600);
  const hourly: Record<string, unknown> = { time };
  for (const v of Object.values(API_VARS)) {
    hourly[`${v}_ecmwf_ifs`] = [1, 2, 3, 4, 5, 6];
    hourly[`${v}_ukmo_global_deterministic_10km`] = [1, 2, 3, null, null, null];       // a short-range model: its run ends
    hourly[`${v}_ncep_aigfs025`] = [null, null, null, null, null, null];                // a model without this variable
  }
  hourly['temperature_2m_ecmwf_ifs'] = [26.1, 25.4, 24.9, 24.6, 24.4, 24.5];
  hourly['precipitation_ecmwf_ifs'] = [0, 0.2, 1.4, 0, 0.6, 0];
  return { latitude: 11.775, longitude: 78.96, elevation: 129, hourly };
}

describe('the request', () => {
  it('asks for every model and variable in one go, speeds in m/s', () => {
    const url = seriesUrl(11.74, 78.96, MODELS);
    const q = new URL(url).searchParams;
    expect(url.startsWith('https://api.open-meteo.com/v1/forecast?')).toBe(true);
    expect(q.get('latitude')).toBe('11.7400');
    expect(q.get('models')).toBe('ecmwf_ifs,ukmo_global_deterministic_10km,ncep_aigfs025');
    expect(q.get('hourly')!.split(',')).toHaveLength(Object.keys(API_VARS).length);
    expect(q.get('wind_speed_unit')).toBe('ms');
    expect(q.get('timeformat')).toBe('unixtime');
    expect(q.get('past_days')).toBe('1');
    expect(q.get('forecast_days')).toBe('10');
  });
});

describe('reading the answer', () => {
  const series = parsePointSeries(answer(), MODELS, 11.74, 78.96)!;

  it('turns the times into milliseconds and keeps the point and its height', () => {
    expect(series.times[0]).toBe(Date.UTC(2026, 9, 12));
    expect(series.times).toHaveLength(6);
    expect(series.elevationM).toBe(129);
    expect(series.lat).toBe(11.74);
  });

  it('gives each model its own series, keyed by our id', () => {
    expect(Object.keys(series.models)).toEqual(['ecmwf_ifs', 'ukmo', 'aigfs']);
    expect(series.models['ecmwf_ifs'].temp).toEqual([26.1, 25.4, 24.9, 24.6, 24.4, 24.5]);
    expect(series.models['ecmwf_ifs'].rain[2]).toBe(1.4);
  });

  it('keeps a gap as a gap, never as zero', () => {
    expect(series.models['ukmo'].temp).toEqual([1, 2, 3, null, null, null]);
    expect(series.models['aigfs'].gust.every(v => v === null)).toBe(true);
  });

  it('refuses what is not an answer', () => {
    expect(parsePointSeries(null, MODELS, 0, 0)).toBeNull();
    expect(parsePointSeries({ error: true, reason: 'Latitude must be in range of -90 to 90°.' }, MODELS, 0, 0)).toBeNull();
    expect(parsePointSeries({ hourly: { time: [] } }, MODELS, 0, 0)).toBeNull();
    expect(parsePointSeries({ hourly: { time: ['x'] } }, MODELS, 0, 0)).toBeNull();
  });

  it('turns a value that is not a number into a gap', () => {
    const bad = answer() as { hourly: Record<string, unknown> };
    bad.hourly['temperature_2m_ecmwf_ifs'] = [20, 'warm', NaN, null, undefined, 21];
    const s = parsePointSeries(bad, MODELS, 0, 0)!;
    expect(s.models['ecmwf_ifs'].temp).toEqual([20, null, null, null, null, 21]);
  });

  it('reads an answer for a single model, which the API gives without the model name', () => {
    const t0 = Date.UTC(2026, 9, 12) / 1000;
    const one = { hourly: { time: [t0, t0 + 3600], temperature_2m: [20, 21] } };
    const s = parsePointSeries(one, [MODELS[0]], 0, 0)!;
    expect(s.models['ecmwf_ifs'].temp).toEqual([20, 21]);
  });
});

describe('looking up the hours', () => {
  const t0 = Date.UTC(2026, 9, 12);
  const times = Array.from({ length: 5 }, (_, i) => t0 + i * 3_600_000);

  it('finds the nearest hour, clamped to the series', () => {
    expect(indexAt(times, t0)).toBe(0);
    expect(indexAt(times, t0 + 1_000_000)).toBe(0);          // 17 min in: still the first hour
    expect(indexAt(times, t0 + 2_000_000)).toBe(1);          // 33 min in: nearer the second
    expect(indexAt(times, t0 - 5e9)).toBe(0);
    expect(indexAt(times, t0 + 5e9)).toBe(4);
    expect(indexAt([], t0)).toBe(-1);
  });

  it('finds where a line starts and ends', () => {
    expect(lastIndex([1, 2, null, null])).toBe(1);
    expect(lastIndex([null, null])).toBe(-1);
    expect(firstIndex([null, 2, 3])).toBe(1);
    expect(firstIndex([null])).toBe(-1);
  });

  it('cuts a window out of the hours', () => {
    expect(windowIndexes(times, t0 + 3_600_000, t0 + 3 * 3_600_000)).toEqual({ from: 1, to: 3 });
    expect(windowIndexes(times, t0 - 9e9, t0 + 9e9)).toEqual({ from: 0, to: 4 });
    expect(windowIndexes(times, t0 + 9e9, t0 + 9e10)).toBeNull();
    expect(windowIndexes([], 0, 1)).toBeNull();
  });
});

describe('totals and spread', () => {
  it('sums hours that have a value, and says nothing when none has', () => {
    expect(sumFrom([1, 2, null, 4], 0, 4)).toBe(7);
    expect(sumFrom([1, 2, null, 4], 1, 2)).toBe(2);
    expect(sumFrom([null, null], 0, 2)).toBeNull();
    expect(sumFrom([1, 2], 5, 3)).toBeNull();
  });

  it('keeps a running total that ends where the model does', () => {
    expect(cumulative([0, 1, 2, 0.5, null, null], 0, 5)).toEqual([0, 1, 3, 3.5, null, null]);
    expect(cumulative([null, 1, null, 2, null], 0, 4)).toEqual([null, 1, 1, 3, null]);          // a hole inside carries the total on
    expect(cumulative([1, 1, 1, 1], 1, 2)).toEqual([1, 2]);                                      // from the start of the window
  });

  it('finds the range of the values, ignoring gaps', () => {
    expect(extent([3, null, -1, 8])).toEqual({ min: -1, max: 8 });
    expect(extent([null, null])).toBeNull();
  });

  it('measures how far apart the models are', () => {
    expect(spreadOf([30, 32.5, null, 29])).toBe(3.5);
    expect(spreadOf([30, null, null])).toBeNull();           // one model alone does not disagree with itself
    expect(spreadOf([])).toBeNull();
  });
});
