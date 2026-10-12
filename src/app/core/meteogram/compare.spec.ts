import { describe, expect, it } from 'vitest';
import { compareAt } from './compare';
import { ModelSeries, PointSeries, SERIES_KEYS, sumFrom } from './point-series';

const T0 = Date.UTC(2026, 9, 12);
const HOURS = 30;

/** A model with the same value for every hour, or no value after `stopsAt`. */
function model(values: Partial<Record<keyof ModelSeries, number>>, stopsAt = HOURS): ModelSeries {
  const out = {} as ModelSeries;
  for (const key of SERIES_KEYS) {
    const v = values[key];
    out[key] = Array.from({ length: HOURS }, (_, i) => (v === undefined || i >= stopsAt ? null : v));
  }
  return out;
}

const series: PointSeries = {
  lat: 11.74,
  lon: 78.96,
  elevationM: 129,
  times: Array.from({ length: HOURS }, (_, i) => T0 + i * 3_600_000),
  models: {
    ecmwf_ifs: model({ temp: 31, feels: 36, rain: 0.5, wind: 4, gust: 9, windDir: 90, pressure: 1008, cloud: 40 }),
    ukmo: model({ temp: 33, feels: 38, rain: 0.1, wind: 5, gust: 12, windDir: 100, pressure: 1010, cloud: 20 }, 10),       // its run ends after 10 hours
    aigfs: model({ temp: 30, rain: 1, wind: 3, pressure: 1007 }),                                                      // no gusts, no feels-like
  },
};

describe('the models side by side', () => {
  it('reads each model at the hour of the time', () => {
    const table = compareAt(series, ['ecmwf_ifs', 'ukmo', 'aigfs'], T0 + 5 * 3_600_000);
    expect(table.index).toBe(5);
    expect(table.timeMs).toBe(T0 + 5 * 3_600_000);
    const ifs = table.rows[0];
    expect(ifs).toMatchObject({ modelId: 'ecmwf_ifs', temp: 31, feels: 36, rain1h: 0.5, wind: 4, gust: 9, pressure: 1008, covered: true });
  });

  it('adds the rain of the next 24 hours only when the run reaches that far', () => {
    const table = compareAt(series, ['ecmwf_ifs', 'ukmo', 'aigfs'], T0 + 2 * 3_600_000);
    expect(table.rows[0].rain24h).toBeCloseTo(12, 6);          // 24 hours of 0.5 mm
    expect(table.rows[1].rain24h).toBeNull();                  // 10 hours of run: no 24 h total
    const late = compareAt(series, ['ecmwf_ifs'], T0 + 10 * 3_600_000);
    expect(late.rows[0].rain24h).toBeNull();                   // 20 hours of data left in this test series
  });

  it('leaves out what a model does not provide, and a model whose run has ended', () => {
    const table = compareAt(series, ['ecmwf_ifs', 'ukmo', 'aigfs'], T0 + 15 * 3_600_000);
    expect(table.rows[1].covered).toBe(false);
    expect(table.rows[1].temp).toBeNull();
    expect(table.rows[2].gust).toBeNull();
    expect(table.rows[2].covered).toBe(true);
  });

  it('measures how far apart the models are, counting only the ones that have a value', () => {
    const early = compareAt(series, ['ecmwf_ifs', 'ukmo', 'aigfs'], T0 + 2 * 3_600_000);
    expect(early.spread.temp).toBe(3);                         // 30 to 33
    expect(early.spread.pressure).toBe(3);                     // 1007 to 1010
    expect(early.spread.gust).toBe(3);                         // 9 and 12; the third has none
    const late = compareAt(series, ['ecmwf_ifs', 'ukmo', 'aigfs'], T0 + 15 * 3_600_000);
    expect(late.spread.temp).toBe(1);                          // 31 and 30
  });

  it('skips a model the series does not have, and clamps a time outside it', () => {
    const table = compareAt(series, ['ecmwf_ifs', 'nope'], T0 - 99 * 3_600_000);
    expect(table.rows.map(r => r.modelId)).toEqual(['ecmwf_ifs']);
    expect(table.index).toBe(0);
  });
});

describe('summing a window', () => {
  it('needs every hour of the window when asked', () => {
    expect(sumFrom([1, 1, 1, 1], 0, 4, true)).toBe(4);
    expect(sumFrom([1, 1, 1, 1], 2, 4, true)).toBeNull();            // runs out
    expect(sumFrom([1, null, 1, 1], 0, 4, true)).toBeNull();         // a hole
    expect(sumFrom([1, null, 1, 1], 0, 4)).toBe(3);                  // the loose form counts what there is
  });
});
