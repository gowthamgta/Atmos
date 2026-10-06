import { describe, expect, it } from 'vitest';
import { blendTime, buildPointRows, inspectVars, liftWindAt, windFromUV } from './point-forecast';
import {
  LAPSE_RATE_C_PER_M,
  MAX_TERRAIN_DELTA_M,
  RH_LOG_PER_M,
  adjustHumidity,
  adjustTemperature,
  PointTerrain,
  applyTerrain,
  terrainDelta,
} from './terrain-correction';

/** Flat ground dz above the model's (no ridges, no slopes, all land), optionally with other properties. */
function ground(dz: number, extra: Partial<PointTerrain> = {}): PointTerrain {
  return {
    fine: 500 + dz, model: 500, dz, tpi: 0, landFine: 1, landModel: 1,
    slope: [0, 0], modelSlope: [0, 0], fineSlope: [0, 0], ...extra,
  };
}

describe('terrain correction', () => {
  it('cools 6.5 °C per km above the model ground and warms below it', () => {
    expect(adjustTemperature(30, 1000)).toBeCloseTo(30 - 6.5, 9);
    expect(adjustTemperature(30, -200)).toBeCloseTo(31.3, 9);
    expect(adjustTemperature(25, 0)).toBe(25);
  });

  it('raises humidity with height (capped at 100) and lowers it below the model ground', () => {
    expect(adjustHumidity(60, 0)).toBe(60);
    expect(adjustHumidity(60, 700)).toBeCloseTo(60 * Math.exp(RH_LOG_PER_M * 700), 9);
    expect(adjustHumidity(60, 700)).toBeGreaterThan(60);
    expect(adjustHumidity(95, 1000)).toBe(100);
    expect(adjustHumidity(60, -500)).toBeLessThan(60);
  });

  it('uses a humidity gain consistent with a 4.7 °C/km shrinking of the dew-point gap', () => {
    expect(RH_LOG_PER_M * 1000).toBeCloseTo(0.0617 * 4.7, 3);
    expect(LAPSE_RATE_C_PER_M).toBe(0.0065);
  });

  it('clamps the height difference and ignores unrelated modes', () => {
    expect(terrainDelta(2000, 100)).toBe(MAX_TERRAIN_DELTA_M);
    expect(terrainDelta(0, 1900)).toBe(-MAX_TERRAIN_DELTA_M);
    expect(terrainDelta(500, 430)).toBe(70);
    expect(applyTerrain(null, 12, 800)).toBe(12);
    expect(applyTerrain('temperature', 20, 100)).toBeCloseTo(19.35, 9);
  });
});

describe('point forecast helpers', () => {
  it('blends time steps and falls back when one side has no data', () => {
    expect(blendTime(10, 20, 0.25)).toBe(12.5);
    expect(blendTime(NaN, 7, 0.9)).toBe(7);
    expect(blendTime(7, NaN, 0.1)).toBe(7);
    expect(blendTime(NaN, NaN, 0.5)).toBeNaN();
  });

  it('gives meteorological wind direction (where the wind comes FROM)', () => {
    expect(windFromUV(0, -5).fromDeg).toBeCloseTo(0, 6);
    expect(windFromUV(-5, 0).fromDeg).toBeCloseTo(90, 6);
    expect(windFromUV(0, 5).fromDeg).toBeCloseTo(180, 6);
    expect(windFromUV(5, 0).fromDeg).toBeCloseTo(270, 6);
    expect(windFromUV(3, 4).speedMs).toBeCloseTo(5, 9);
  });

  it('asks for the ground fields and the 850 hPa lift wind, plus the chosen altitude when there is one', () => {
    const surface = inspectVars('surface');
    expect(surface).toContain('t2m');
    expect(surface).toEqual(expect.arrayContaining(['u850', 'v850']));
    expect(surface.some(v => /^(t|rh|gh)\d{3}$/.test(v))).toBe(false);
    expect(inspectVars(850)).toEqual([...surface, 't850', 'rh850', 'gh850']);
    expect(new Set(inspectVars(850)).size).toBe(inspectVars(850).length);
  });

  it('drives the lift with the 850 hPa wind when it exists, else the 10 m wind', () => {
    expect(liftWindAt({ u850: 8, v850: 2, u10: 3, v10: 1 })).toEqual([8, 2]);
    expect(liftWindAt({ u850: NaN, v850: 2, u10: 3, v10: 1 })).toEqual([3, 1]);
    expect(liftWindAt({})).toBeNull();
  });

  const values: Record<string, number> = {
    t2m: 30, feels: 34, dew: 24, rh: 70, u10: 0, v10: -5, gust: 10, precip: 2.34, cloud: 80, cloud_low: 40, cloud_mid: 20, cloud_high: 10,
    vis: 8.4, msl: 1008.4, cape: 1500,
  };
  const find = (rows: ReturnType<typeof buildPointRows>, id: string) => rows.find(r => r.id === id)!;

  it('moves every near-surface value to the 1 km ground and marks it', () => {
    const rows = buildPointRows(values, ground(1000));
    expect(rows.filter(r => r.terrainAdjusted).map(r => r.id)).toEqual(['temp', 'feels', 'dew', 'humidity', 'wind', 'gust', 'rain']);
    expect(find(rows, 'dew').text).toBe('22.2 °C'); // 1.8 °C per km
    expect(find(rows, 'temp').text).toBe('23.5 °C');
    expect(find(rows, 'wind').text).toMatch(/^18 km\/h from N/);
    expect(find(rows, 'rain').text).toBe('2.3 mm/h');
    expect(find(rows, 'pressure').text).toBe('1008 hPa');
  });

  it('shows the extra surface parameters', () => {
    const rows = buildPointRows(values, null);
    expect(find(rows, 'dew').text).toBe('24.0 °C');
    expect(find(rows, 'cloudlayers').text).toBe('40 / 20 / 10 %');
    expect(find(rows, 'vis').text).toBe('8.4 km');
  });

  it('shows raw model values when the terrain is not available', () => {
    const rows = buildPointRows(values, null);
    expect(rows.some(r => r.terrainAdjusted)).toBe(false);
    expect(find(rows, 'temp').text).toBe('30.0 °C');
  });

  it('shows a dash, not "– km/h", for variables a model does not publish, and hides rows it cannot fill', () => {
    const rows = buildPointRows({ ...values, gust: NaN, cape: NaN, vis: NaN, cloud_low: NaN, cloud_mid: NaN, cloud_high: NaN }, ground(0));
    expect(find(rows, 'gust').text).toBe('–');
    expect(find(rows, 'cape').text).toBe('–');
    expect(find(rows, 'temp').text).toBe('30.0 °C');
    expect(rows.some(r => r.id === 'vis' || r.id === 'cloudlayers')).toBe(false);
  });

  it('adds the 24 h rain, the heavy-rain chances and the stability rows only where the model has them', () => {
    const plain = buildPointRows(values, null);
    for (const id of ['rain24', 'rainchance', 'cin', 'li']) expect(plain.some(r => r.id === id)).toBe(false);

    const rich = buildPointRows({ ...values, rain24: 42.6, px65: 30, px115: 8.4, px204: 0, cin: 85, li: -3.4 }, null);
    expect(find(rich, 'rain24').text).toBe('43 mm');
    expect(rich.findIndex(r => r.id === 'rain24')).toBe(rich.findIndex(r => r.id === 'rain') + 1);     // right under the rain row
    expect(find(rich, 'rainchance').text).toBe('30 / 8 / 0 %');
    expect(find(rich, 'cin').text).toBe('85 J/kg');
    expect(find(rich, 'li').text).toBe('-3.4 °C');
    // a small total keeps a decimal, and a chance the model lacks is left out of the list
    expect(find(buildPointRows({ ...values, rain24: 4.26 }, null), 'rain24').text).toBe('4.3 mm');
    expect(find(buildPointRows({ ...values, px65: 12, px115: NaN, px204: NaN }, null), 'rainchance').text).toBe('12 %');
  });

  it('rain over the next 24 h gets the same hill correction as the rain rate', () => {
    const rows = buildPointRows({ ...values, rain24: 40, u850: 10, v850: 0 }, ground(0, { tpi: 0 }));
    expect(find(rows, 'rain24').terrainAdjusted).toBe(find(rows, 'rain').terrainAdjusted);
  });

  it('adds a block for the chosen altitude, and none at the ground', () => {
    const aloft = { ...values, t850: 19.2, rh850: 62, u850: 10, v850: 0, gh850: 1532 };
    const rows = buildPointRows(aloft, ground(0), 850);
    const heading = find(rows, 'level-heading');
    expect(heading.heading).toBe(true);
    expect(heading.label).toContain('850 hPa');
    expect(find(rows, 'lvl-temp').text).toBe('19.2 °C');
    expect(find(rows, 'lvl-humidity').text).toBe('62 %');
    expect(find(rows, 'lvl-wind').text).toMatch(/^36 km\/h from W/);
    expect(find(rows, 'lvl-height').text).toBe('1532 m');
    expect(buildPointRows(aloft, ground(0), 'surface').some(r => r.id.startsWith('lvl-'))).toBe(false);
    // a model without that level shows dashes rather than failing
    expect(find(buildPointRows(values, ground(0), 500), 'lvl-temp').text).toBe('–');
  });

  it('makes a ridge windier, a windward slope wetter and a lee slope drier', () => {
    const flat = buildPointRows(values, ground(0));
    const ridge = buildPointRows(values, ground(0, { tpi: 200 }));
    const kmh = (rows: ReturnType<typeof buildPointRows>) => parseFloat(find(rows, 'wind').text);
    expect(kmh(ridge)).toBeGreaterThan(kmh(flat));
    // wind from the north (v10 = -5) blowing up a slope that rises to the south (gy < 0): lift, more rain
    const windward = buildPointRows(values, ground(0, { slope: [0, -0.05] }));
    const lee = buildPointRows(values, ground(0, { slope: [0, 0.05] }));
    const rain = (rows: ReturnType<typeof buildPointRows>) => parseFloat(find(rows, 'rain').text);
    expect(rain(windward)).toBeGreaterThan(rain(flat));
    expect(rain(lee)).toBeLessThan(rain(flat));
    expect(parseFloat(find(windward, 'cloudlayers').text)).toBeGreaterThan(40); // low cloud thickens too
  });
});
