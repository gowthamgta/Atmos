import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID, FORECAST_MODELS, forecastModelById } from './forecast-models';

describe('forecast model registry', () => {
  it('has unique ids and base URLs, each under the Pages site', () => {
    expect(new Set(FORECAST_MODELS.map(m => m.id)).size).toBe(FORECAST_MODELS.length);
    expect(new Set(FORECAST_MODELS.map(m => m.baseUrl)).size).toBe(FORECAST_MODELS.length);
    for (const m of FORECAST_MODELS) {
      expect(m.baseUrl.endsWith(`/${m.id}`)).toBe(true); // folder name matches the pipeline's MODEL_ID
      expect(m.label).toBeTruthy();
      expect(m.resolution).toBeTruthy();
    }
  });

  it('lists every pipeline model by its folder id, with ECMWF IFS as the default', () => {
    expect(forecastModelById(DEFAULT_MODEL_ID).id).toBe('ecmwf_ifs');
    expect(forecastModelById('gfs').label).toBe('NOAA GFS');
    expect(FORECAST_MODELS.map(m => m.id).sort()).toEqual(
      ['aigfs', 'arpege', 'cma_grapes', 'dwd_icon', 'ecmwf_aifs', 'ecmwf_ifs', 'gdps', 'gfs', 'jma_gsm', 'ukmo']
    );
  });

  it('falls back to the default model for an unknown id', () => {
    expect(forecastModelById('nope').id).toBe(DEFAULT_MODEL_ID);
  });
});
