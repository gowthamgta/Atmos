import { describe, expect, it } from 'vitest';
import { TERRAIN_MODE_CODE } from '../rendering/scalar-field.layer';
import { liftWindVars } from './forecast-map.controller';
import { FORECAST_LAYERS, LEVEL_KM, forecastLayerById, resolveLayer } from './forecast-layers';
import { FORECAST_MODELS } from './forecast-models';
import { nearestModelKm } from './terrain.service';

describe('1 km downscaling registry', () => {
  it('gives every near-surface layer that the terrain affects a downscaling mode the shader knows', () => {
    const modes = Object.fromEntries(FORECAST_LAYERS.map(l => [l.id, l.terrain]));
    expect(modes).toMatchObject({
      temp: 'temperature', tmin24: 'temperature', tmax24: 'temperature', feels: 'temperature', dew: 'dewpoint', humidity: 'humidity', wind: 'wind', gust: 'wind',
      rain: 'rain', rain24: 'rain', tcwv: 'column',
    });
    for (const l of FORECAST_LAYERS) if (l.terrain) expect(TERRAIN_MODE_CODE[l.terrain]).toBeGreaterThan(0);
    expect(new Set(Object.values(TERRAIN_MODE_CODE)).size).toBe(Object.keys(TERRAIN_MODE_CODE).length);
  });

  it('marks pressure-level layers with their height, so ground above the level can be shown as underground', () => {
    const t850 = resolveLayer(forecastLayerById('temp')!, 850);
    expect(t850.levelHeightM).toBe(LEVEL_KM[850] * 1000);
    expect(t850.terrain).toBeNull();
    expect(forecastLayerById('temp')!.levelHeightM).toBeUndefined();
  });

  it('lifts with the 850 hPa wind when published, else the 10 m wind', () => {
    expect(liftWindVars({ u850: {}, v850: {}, u10: {}, v10: {} })).toEqual(['u850', 'v850']);
    expect(liftWindVars({ u10: {}, v10: {} })).toEqual(['u10', 'v10']);
    expect(liftWindVars({ u850: {} })).toBeNull();
  });

  it('matches every model to the model-ground terrain closest to its native grid', () => {
    const available = [9, 10, 13, 15, 28, 55];
    expect(nearestModelKm(available, 9)).toBe(9);
    expect(nearestModelKm(available, 25)).toBe(28);
    expect(nearestModelKm(available, 70)).toBe(55);
    for (const m of FORECAST_MODELS) expect(available).toContain(nearestModelKm(available, m.gridKm));
  });
});
