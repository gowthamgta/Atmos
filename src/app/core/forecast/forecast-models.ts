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
  /**
   * Native grid spacing (km) of the near-surface fields: how coarse the model's own view of the terrain is, which
   * sets how much the 90 m terrain correction has to add.
   */
  gridKm: number;
  baseUrl: string;
}

export const PAGES = 'https://gowthamgta.github.io/Atmos';

export const FORECAST_MODELS: readonly ForecastModelDef[] = [
  { id: 'ecmwf_ifs', label: 'ECMWF IFS', resolution: '9 km', gridKm: 9, baseUrl: `${PAGES}/ecmwf_ifs` },
  { id: 'blend', label: 'All models (blend)', resolution: '5 models', gridKm: 13, baseUrl: `${PAGES}/blend` },
  { id: 'ecmwf_aifs', label: 'ECMWF AIFS (AI)', resolution: '28 km', gridKm: 28, baseUrl: `${PAGES}/ecmwf_aifs` },
  { id: 'gfs', label: 'NOAA GFS', resolution: '13–28 km', gridKm: 13, baseUrl: `${PAGES}/gfs` },
  { id: 'ukmo', label: 'UK Met Office', resolution: '10 km', gridKm: 10, baseUrl: `${PAGES}/ukmo` },
  { id: 'dwd_icon', label: 'DWD ICON', resolution: '13 km', gridKm: 13, baseUrl: `${PAGES}/dwd_icon` },
  { id: 'world_ifs', label: 'ECMWF IFS · world', resolution: '110 km, whole globe', gridKm: 110, baseUrl: `${PAGES}/world_ifs` },
];

export const DEFAULT_MODEL_ID = FORECAST_MODELS[0].id;

export function forecastModelById(id: string): ForecastModelDef {
  return FORECAST_MODELS.find(m => m.id === id) ?? FORECAST_MODELS[0];
}
