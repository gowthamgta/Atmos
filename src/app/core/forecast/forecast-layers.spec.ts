import { describe, expect, it } from 'vitest';
import {
  ALL_LEVELS,
  FORECAST_LAYERS,
  LAYER_GROUPS,
  PRESSURE_LEVELS,
  availableLevels,
  buildPaletteLut,
  contourSpec,
  forecastLayerById,
  layerAvailable,
  layerAvailableAt,
  legendPosition,
  resolveLayer,
  supportsLevels,
  windVars,
} from './forecast-layers';

// the variables a model publishes, as they appear in a manifest
const vars = (...ids: string[]): Record<string, object> => Object.fromEntries(ids.map(id => [id, {}]));
const levelVars = (levels: readonly number[], kinds = ['u', 'v', 't', 'rh', 'gh']) => levels.flatMap(l => kinds.map(k => `${k}${l}`));
const SURFACE = ['t2m', 'rh', 'feels', 'dew', 'u10', 'v10', 'gust', 'msl', 'precip', 'cloud', 'cloud_low', 'cloud_mid', 'cloud_high', 'vis', 'solar', 'cape', 'tcwv',
  'li', 'cin', 'rain24', 'px2', 'px16', 'px65', 'px115'];

describe('forecast layer registry', () => {
  it('has unique ids, sane ranges, and every layer in a known group', () => {
    const ids = FORECAST_LAYERS.map(l => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of FORECAST_LAYERS) {
      expect(l.max).toBeGreaterThan(l.min);
      expect(l.stops.length).toBeGreaterThanOrEqual(2);
      expect(LAYER_GROUPS).toContain(l.group);
      const scale = l.displayScale ?? 1; // ticks are in the displayed unit, the range in the field's own unit
      expect(l.ticks.every(t => t / scale >= l.min && t / scale <= l.max)).toBe(true);
    }
  });

  it('keeps only visibility in the clouds group, and adds accumulation, stability and rain-chance layers', () => {
    const inGroup = (g: string) => FORECAST_LAYERS.filter(l => l.group === g).map(l => l.id);
    expect(inGroup('Visibility')).toEqual(['vis']);
    for (const gone of ['clouds', 'cloud_low', 'cloud_mid', 'cloud_high', 'solar']) expect(forecastLayerById(gone)).toBeNull();
    expect(inGroup('Rain and humidity')).toEqual(expect.arrayContaining(['rain', 'rain24']));
    expect(inGroup('Rain chance (24 h)')).toEqual(['px2', 'px16', 'px65', 'px115']);
    expect(inGroup('Pressure and storms')).toEqual(expect.arrayContaining(['li', 'cin', 'cape']));
    // the chances run from 0 to 100 percent; the unstable end of the lifted index is the warm colour
    for (const id of ['px2', 'px16', 'px65', 'px115']) expect([forecastLayerById(id)!.min, forecastLayerById(id)!.max]).toEqual([0, 100]);
    expect(forecastLayerById('li')!.min).toBeLessThan(0);
    expect(forecastLayerById('li')!.stops[0]).toBe('#b3262f');
  });

  it('only references variables the pipeline publishes', () => {
    const published = new Set([...SURFACE, ...levelVars(PRESSURE_LEVELS)]);
    for (const l of FORECAST_LAYERS) {
      expect(published).toContain(l.varId);
      if (l.varId2) expect(published).toContain(l.varId2);
      for (const lvl of PRESSURE_LEVELS) {
        if (!l.atLevel) continue;
        const spec = l.atLevel(lvl);
        expect(published).toContain(spec.varId);
        if (spec.varId2) expect(published).toContain(spec.varId2);
      }
    }
  });

  it('builds an opaque palette that starts and ends on the first and last colour', () => {
    const lut = buildPaletteLut(['#000000', '#ffffff']);
    expect(lut.length).toBe(256 * 4);
    expect([...lut.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...lut.slice(-4)]).toEqual([255, 255, 255, 255]);
    expect(lut[128 * 4]).toBeGreaterThan(120);
    expect(lut[128 * 4]).toBeLessThan(135);
  });

  it('positions legend ticks with the layer gamma and the display scale', () => {
    const rain = forecastLayerById('rain')!;
    expect(legendPosition(rain, 0)).toBe(0);
    expect(legendPosition(rain, 20)).toBe(1);
    expect(legendPosition(rain, 5)).toBeCloseTo(0.5, 6); // sqrt(5/20)
    const wind = forecastLayerById('wind')!;
    expect(legendPosition(wind, 72)).toBeCloseTo(1, 9); // 20 m/s = 72 km/h is the top of the palette
    expect(legendPosition(wind, 36)).toBeCloseTo(0.5, 9);
    expect(forecastLayerById('nope')).toBeNull();
  });
});

describe('altitude', () => {
  it('offers the ground and six pressure levels', () => {
    expect(ALL_LEVELS).toEqual(['surface', 925, 850, 700, 500, 300, 200]);
  });

  it('only temperature, humidity, wind and pressure/height can be drawn aloft', () => {
    expect(FORECAST_LAYERS.filter(supportsLevels).map(l => l.id).sort()).toEqual(['humidity', 'pressure', 'temp', 'wind']);
  });

  it('resolves a layer to the variables, range and label of the chosen level', () => {
    const temp = resolveLayer(forecastLayerById('temp')!, 500);
    expect(temp.varId).toBe('t500');
    expect(temp.label).toBe('Temperature · 500 hPa');
    expect(temp.terrain).toBeNull(); // the 1 km terrain correction is a near-surface thing
    expect(temp.min).toBeLessThan(-8); // 500 hPa is about -5 degC in the tropics, inside the range
    expect(temp.max).toBeGreaterThan(-5);
    expect(temp.stops).toEqual(forecastLayerById('temp')!.stops); // same palette

    const wind = resolveLayer(forecastLayerById('wind')!, 300);
    expect([wind.varId, wind.varId2]).toEqual(['u300', 'v300']);
    expect(wind.displayScale).toBe(3.6); // still shown in km/h
    expect(wind.max).toBeGreaterThan(forecastLayerById('wind')!.max); // jets are faster than the ground wind

    const height = resolveLayer(forecastLayerById('pressure')!, 850);
    expect(height.varId).toBe('gh850');
    expect(height.unit).toBe('m');
    expect(height.label).toContain('850 hPa');
  });

  it('leaves the layer alone at the ground and for ground-only layers', () => {
    const temp = forecastLayerById('temp')!;
    expect(resolveLayer(temp, 'surface')).toBe(temp);
    const rain = forecastLayerById('rain')!;
    expect(resolveLayer(rain, 500)).toBe(rain);
  });

  it('keeps every level inside its own legend range for typical tropical values', () => {
    const typical: Record<number, { t: number; gh: number }> = {
      925: { t: 24, gh: 790 }, 850: { t: 19, gh: 1530 }, 700: { t: 9, gh: 3170 }, 500: { t: -5, gh: 5890 }, 300: { t: -31, gh: 9725 }, 200: { t: -52, gh: 12470 },
    };
    for (const lvl of PRESSURE_LEVELS) {
      const t = resolveLayer(forecastLayerById('temp')!, lvl);
      const h = resolveLayer(forecastLayerById('pressure')!, lvl);
      expect(typical[lvl].t).toBeGreaterThanOrEqual(t.min);
      expect(typical[lvl].t).toBeLessThanOrEqual(t.max);
      expect(typical[lvl].gh).toBeGreaterThanOrEqual(h.min);
      expect(typical[lvl].gh).toBeLessThanOrEqual(h.max);
    }
  });

  it('works out which altitudes a model has', () => {
    expect(availableLevels(null)).toEqual([...ALL_LEVELS]);
    expect(availableLevels(vars(...SURFACE))).toEqual(['surface']);
    expect(availableLevels(vars(...SURFACE, ...levelVars([850, 500])))).toEqual(['surface', 850, 500]);
    expect(availableLevels(vars(...SURFACE, ...levelVars(PRESSURE_LEVELS)))).toEqual([...ALL_LEVELS]);
  });

  it('marks a layer unavailable at an altitude the model lacks, and ground-only layers aloft', () => {
    const noLevels = vars(...SURFACE);
    const full = vars(...SURFACE, ...levelVars(PRESSURE_LEVELS));
    const temp = forecastLayerById('temp')!;
    expect(layerAvailableAt(temp, 'surface', noLevels)).toBe(true);
    expect(layerAvailableAt(temp, 850, noLevels)).toBe(false);
    expect(layerAvailableAt(temp, 850, full)).toBe(true);
    expect(layerAvailableAt(forecastLayerById('rain')!, 850, full)).toBe(false); // rain has no pressure-level version
    expect(layerAvailableAt(forecastLayerById('rain')!, 'surface', full)).toBe(true);
    // a model whose humidity stops short of 200 hPa (a model with a short humidity profile) still has the other levels
    const shortHumidity = vars(...SURFACE, ...levelVars(PRESSURE_LEVELS).filter(v => v !== 'rh200'));
    expect(layerAvailableAt(forecastLayerById('humidity')!, 200, shortHumidity)).toBe(false);
    expect(layerAvailableAt(forecastLayerById('humidity')!, 300, shortHumidity)).toBe(true);
  });

  it('keeps the plain availability check for surface variables', () => {
    expect(layerAvailable(forecastLayerById('gust')!, vars('t2m'))).toBe(false);
    expect(layerAvailable(forecastLayerById('wind')!, vars('u10'))).toBe(false); // needs v10 as well
    expect(layerAvailable(forecastLayerById('cape')!, null)).toBe(true);
  });

  it('points the wind animation and the contour lines at the chosen level', () => {
    expect(windVars('surface')).toEqual(['u10', 'v10']);
    expect(windVars(700)).toEqual(['u700', 'v700']);
    expect(contourSpec('surface')).toEqual({ varId: 'msl', step: 2, unit: 'hPa' });
    expect(contourSpec(500)).toEqual({ varId: 'gh500', step: 20, unit: 'm' });
    for (const lvl of PRESSURE_LEVELS) expect(contourSpec(lvl).step).toBeGreaterThan(0);
  });
});
