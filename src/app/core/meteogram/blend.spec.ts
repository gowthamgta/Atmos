import { describe, it, expect } from 'vitest';
import { applyCorrections, CorrectionsFile } from './blend';
import { ModelSeries, PointSeries, SERIES_KEYS } from './point-series';
import { withCorrections } from './point-series.service';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 6); // 06 UTC

function model(values: Partial<Record<keyof ModelSeries, (number | null)[]>>, n = 2): ModelSeries {
  const s = {} as ModelSeries;
  for (const k of SERIES_KEYS) s[k] = values[k] ?? new Array(n).fill(null);
  return s;
}

/** Two hours at Chennai airport. */
function series(models: Record<string, ModelSeries>): PointSeries {
  return { lat: 12.994, lon: 80.18, elevationM: 10, times: [T0, T0 + H], models };
}

const corr: CorrectionsFile = {
  airports: { VOMM: [12.994, 80.18] },
  models: {
    a: { api: 'a_api', map: true, temp: { VOMM: new Array(24).fill(0).map((_, h) => (h === 6 ? 2 : 1)) }, rh: { VOMM: new Array(24).fill(-5) }, rain_threshold_mm: 0.5 },
    b: { api: 'b_api', map: true, rain_threshold_mm: 0.2 },
    x: { api: 'icon_global', map: false },
  },
  blend: { temp: { a: 3, b: 1 }, rain: { a: 1, b: 1 }, rain_cutoff: 0.5 },
};

describe('corrections at a place', () => {
  it('takes each model its usual error off by hour of the day (UTC), feels-like with the air temperature', () => {
    const s = applyCorrections(series({ a: model({ temp: [30, 30], feels: [33, 33], humidity: [98, 60] }), b: model({ temp: [28, 28] }) }), corr);
    expect(s.models['a'].temp).toEqual([28, 29]); // 2 C at 06 UTC, 1 C at 07 UTC
    expect(s.models['a'].feels).toEqual([31, 32]);
    expect(s.models['a'].humidity).toEqual([100, 65]); // 98 + 5 kept at 100
    expect(s.models['b'].temp).toEqual([28, 28]); // no correction for b
  });

  it('leaves a place far from every airport as it is', () => {
    const far: PointSeries = { ...series({ a: model({ temp: [30, 30] }) }), lat: 20, lon: 75 };
    expect(applyCorrections(far, corr)).toBe(far);
  });
});

describe('the series the meteogram draws', () => {
  it('has each model corrected at the place, and nothing else added', () => {
    const s = withCorrections(series({ a: model({ temp: [30, 30] }), b: model({ temp: [26, 26] }) }), corr);
    expect(s.models['a'].temp).toEqual([28, 29]);
    expect(Object.keys(s.models).sort()).toEqual(['a', 'b']);
    const plain = series({ a: model({ temp: [30, 30] }) });
    expect(withCorrections(plain, null)).toBe(plain);
  });
});
