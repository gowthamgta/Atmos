import { describe, it, expect } from 'vitest';
import { applyCorrections, blendSeries, blendTrusted, CorrectionsFile, extraBlendModels } from './blend';
import { ModelSeries, PointSeries, SERIES_KEYS } from './point-series';
import { withBlend } from './point-series.service';

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

describe('the blend', () => {
  it('weights the models, shares out the weight of one without a value, and averages the wind as vectors', () => {
    const s = series({
      a: model({ temp: [30, null], wind: [2, 2], windDir: [350, 90], rain: [0.6, 0.1] }),
      b: model({ temp: [26, 26], wind: [2, 2], windDir: [10, 90], rain: [0.3, 0.1] }),
    });
    const b = blendSeries(s, corr)!;
    expect(b.blend.temp).toEqual([29, 26]); // (3 x 30 + 26) / 4, then b alone
    expect(Math.round(b.blend.windDir[0]!) % 360).toBe(355); // between 350 and 10, weighted toward a: north, not south
    expect(b.blend.windDir[1]).toBeCloseTo(90, 6);
    // a has rain from 0.5 mm, b from 0.2 mm: both in the first hour, neither in the second
    expect(b.rainChance).toEqual([1, 0]);
  });

  it('is not made without weights', () => {
    expect(blendSeries(series({ a: model({ temp: [1, 1] }) }), { ...corr, blend: {} })).toBeNull();
  });

  it('asks for the models only the blend needs', () => {
    expect(extraBlendModels({ ...corr, blend: { temp: { a: 1, x: 1 } } }, ['a', 'b'])).toEqual([{ id: 'x', apiId: 'icon_global' }]);
    expect(extraBlendModels(null, ['a'])).toEqual([]);
  });

  it('adds the corrected models and the blend to the series the meteogram draws', () => {
    const s = withBlend(series({ a: model({ temp: [30, 30] }), b: model({ temp: [26, 26] }) }), corr);
    expect(s.models['a'].temp).toEqual([28, 29]);
    expect(s.models['blend'].temp).toEqual([27.5, 28.25]); // (3 x 28 + 26) / 4 and (3 x 29 + 26) / 4
    expect(s.rainChance).toBeDefined();
    const plain = series({ a: model({ temp: [30, 30] }) });
    expect(withBlend(plain, null)).toBe(plain);
  });
});

describe('when the blend stands in for a model', () => {
  it('only when its backtest beats every single model, corrected or not', () => {
    const bt = (temp_mae: Record<string, number>) => ({ ...corr, backtest: { test_days: ['a', 'b'] as [string, string], temp_mae, rain_threat: {} } });
    expect(blendTrusted(bt({ a: 1.6, 'a+corrected': 1.2, b: 1.1, blend: 1.0 }))).toBe(true);
    expect(blendTrusted(bt({ a: 1.6, 'a+corrected': 0.9, blend: 1.0 }))).toBe(false);
    expect(blendTrusted(bt({ a: 1.6 }))).toBe(false);
    expect(blendTrusted(null)).toBe(false);
  });
});
