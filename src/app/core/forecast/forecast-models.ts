/**
 * Forecast models the app can show. Each model is published by its own pipeline job under
 * <baseUrl>/latest.json and <baseUrl>/<run>/manifest.json (see pipeline/README.md), in the same format,
 * so adding a model means adding an entry here and a job in the pipeline.
 */
export interface ForecastModelDef {
  id: string;
  label: string;
  /** Native resolution, for display. */
  resolution: string;
  baseUrl: string;
}

const PAGES = 'https://gowthamgta.github.io/Atmos';

export const FORECAST_MODELS: readonly ForecastModelDef[] = [
  { id: 'ecmwf_ifs', label: 'ECMWF IFS', resolution: '9 km', baseUrl: `${PAGES}/ecmwf_ifs` },
  { id: 'gfs', label: 'NOAA GFS', resolution: '13–28 km', baseUrl: `${PAGES}/gfs` },
  { id: 'ecmwf_aifs', label: 'ECMWF AIFS (AI)', resolution: '28 km', baseUrl: `${PAGES}/ecmwf_aifs` },
];

export const DEFAULT_MODEL_ID = FORECAST_MODELS[0].id;

export function forecastModelById(id: string): ForecastModelDef {
  return FORECAST_MODELS.find(m => m.id === id) ?? FORECAST_MODELS[0];
}
