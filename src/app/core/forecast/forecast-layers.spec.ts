import { tempStops } from './windy-palettes';
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
const levelVars = (levels: readonly number[], kinds = ['u', 'v', 't', 'rh', 'gh', 'w', 'vo', 'dv']) => levels.flatMap(l => kinds.map(k => `${k}${l}`));
const SURFACE = ['t2m', 'rh', 'feels', 'dew', 'u10', 'v10', 'gust', 'msl', 'precip', 'cloud', 'cloud_low', 'cloud_mid', 'cloud_high', 'vis', 'solar', 'cape', 'tcwv',
  'li', 'cin', 'raintot', 'extreme', 'tmin24', 'tmax24'];

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

  it('keeps only visibility in the clouds group, and keeps rain accumulation, stability and tcwv layers', () => {
    const inGroup = (g: string) => FORECAST_LAYERS.filter(l => l.group === g).map(l => l.id);
    expect(inGroup('Visibility')).toEqual(['vis']);
    for (const gone of ['clouds', 'cloud_low', 'cloud_mid', 'cloud_high', 'solar', 'rain', 'rain24', 'extreme']) expect(forecastLayerById(gone)).toBeNull();
    expect(inGroup('Rain and humidity')).toEqual(['humidity', 'raintot', 'tcwv']);
    expect(inGroup('Pressure and storms')).toEqual(expect.arrayContaining(['li', 'cin', 'cape']));
    // the unstable end of the lifted index is the warm colour
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

  it('lets a palette fade to transparent with an eight-digit colour', () => {
    const lut = buildPaletteLut(['#ffffff00', '#ffffffff']);
    expect([...lut.slice(0, 4)]).toEqual([255, 255, 255, 0]);
    expect([...lut.slice(-4)]).toEqual([255, 255, 255, 255]);
    expect(lut[128 * 4 + 3]).toBeGreaterThan(120);
    expect(lut[128 * 4 + 3]).toBeLessThan(135);
  });

  it('positions legend ticks with the layer gamma and the display scale', () => {
    const raintot = forecastLayerById('raintot')!;
    expect(legendPosition(raintot, 0)).toBe(0);
    expect(legendPosition(raintot, 300)).toBe(1);
    const wind = forecastLayerById('wind')!;
    expect(legendPosition(wind, 72)).toBeCloseTo(1, 9); // 20 m/s = 72 km/h is the top of the palette
    expect(legendPosition(wind, 36)).toBeCloseTo(0.5, 9);
    expect(forecastLayerById('nope')).toBeNull();
  });
});

describe('altitude', () => {
  it('offers the ground and selected pressure levels', () => {
    expect(ALL_LEVELS).toEqual(['surface', 850, 800, 700, 600, 200]);
  });

  it('only the upper-air layers (and temperature, humidity, wind, height) can be drawn aloft', () => {
    expect(FORECAST_LAYERS.filter(supportsLevels).map(l => l.id).sort()).toEqual(['divergence', 'humidity', 'pressure', 'temp', 'vertical', 'vorticity', 'wind']);
  });

  it('resolves a layer to the variables, range and label of the chosen level', () => {
    const temp = resolveLayer(forecastLayerById('temp')!, 700);
    expect(temp.varId).toBe('t700');
    expect(temp.label).toBe('Temperature · 700 hPa');
    expect(temp.terrain).toBeNull(); // the 90 m terrain correction is a near-surface thing
    expect(temp.min).toBeLessThan(0);
    expect(temp.max).toBeGreaterThan(10);
    expect(temp.stops).toEqual(tempStops(temp.min, temp.max)); // the same colour for the same temperature, over the level's range

    const wind = resolveLayer(forecastLayerById('wind')!, 200);
    expect([wind.varId, wind.varId2]).toEqual(['u200', 'v200']);
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
    const raintot = forecastLayerById('raintot')!;
    expect(resolveLayer(raintot, 700)).toBe(raintot);
  });

  it('keeps every level inside its own legend range for typical tropical values', () => {
    const typical: Record<number, { t: number; gh: number }> = {
      925: { t: 24, gh: 790 }, 850: { t: 19, gh: 1530 }, 800: { t: 15, gh: 2040 }, 700: { t: 9, gh: 3170 }, 600: { t: 1, gh: 4350 }, 500: { t: -5, gh: 5890 }, 300: { t: -31, gh: 9725 }, 250: { t: -42, gh: 10450 }, 200: { t: -52, gh: 12470 },
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
    expect(availableLevels(vars(...SURFACE, ...levelVars([850, 700])))).toEqual(['surface', 850, 700]);
    expect(availableLevels(vars(...SURFACE, ...levelVars(PRESSURE_LEVELS)))).toEqual([...ALL_LEVELS]);
  });

  it('marks a layer unavailable at an altitude the model lacks, and ground-only layers aloft', () => {
    const noLevels = vars(...SURFACE);
    const full = vars(...SURFACE, ...levelVars(PRESSURE_LEVELS));
    const temp = forecastLayerById('temp')!;
    expect(layerAvailableAt(temp, 'surface', noLevels)).toBe(true);
    expect(layerAvailableAt(temp, 850, noLevels)).toBe(false);
    expect(layerAvailableAt(temp, 850, full)).toBe(true);
    expect(layerAvailableAt(forecastLayerById('raintot')!, 850, full)).toBe(false); // rain accumulation has no pressure-level version
    expect(layerAvailableAt(forecastLayerById('raintot')!, 'surface', full)).toBe(true);
    // a model whose humidity stops short of 200 hPa (a model with a short humidity profile) still has the other levels
    const shortHumidity = vars(...SURFACE, ...levelVars(PRESSURE_LEVELS).filter(v => v !== 'rh200'));
    expect(layerAvailableAt(forecastLayerById('humidity')!, 200, shortHumidity)).toBe(false);
    expect(layerAvailableAt(forecastLayerById('humidity')!, 700, shortHumidity)).toBe(true);
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
    expect(contourSpec(700)).toEqual({ varId: 'gh700', step: 10, unit: 'm' });
    for (const lvl of PRESSURE_LEVELS) expect(contourSpec(lvl).step).toBeGreaterThan(0);
  });

  it('has layers that only exist aloft, offered only at a pressure level', () => {
    const full = vars(...SURFACE, ...levelVars(PRESSURE_LEVELS));
    for (const id of ['vertical', 'vorticity', 'divergence']) {
      const def = forecastLayerById(id)!;
      expect(def.levelOnly).toBe(true);
      expect(layerAvailableAt(def, 'surface', full)).toBe(false);
      expect(layerAvailableAt(def, 700, full)).toBe(true);
      expect(resolveLayer(def, 700).varId).toMatch(/700$/);
    }
  });
});
