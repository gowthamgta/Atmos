/**
 * Forecast models the app can show. Each model is published by its own pipeline job under
 * <baseUrl>/latest.json and <baseUrl>/<run>/manifest.json (see pipeline/README.md), in the same format,
 * so adding a model means adding an entry here and a job in the pipeline.
 */
export interface ForecastModelDef {
  id: string;
  label: string;
  /** The short name on the model buttons ("ECMWF", "GFS"); the grid spacing is added to it. */
  short: string;
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
  { id: 'ecmwf_ifs', label: 'ECMWF IFS', short: 'ECMWF', resolution: '9 km, all India', gridKm: 9, baseUrl: `${PAGES}/ecmwf_ifs` },
  { id: 'ukmo', label: 'UK Met Office', short: 'UKMO', resolution: '10 km, all India', gridKm: 10, baseUrl: `${PAGES}/ukmo` },
  { id: 'gfs', label: 'NOAA GFS', short: 'GFS', resolution: '13 km surface, all India', gridKm: 13, baseUrl: `${PAGES}/gfs` },
  { id: 'aigfs', label: 'NOAA AIGFS', short: 'AIGFS', resolution: '25 km, all India', gridKm: 25, baseUrl: `${PAGES}/aigfs` },
  { id: 'aifs', label: 'ECMWF AIFS', short: 'AIFS', resolution: '25 km, all India', gridKm: 25, baseUrl: `${PAGES}/aifs` },
];

export const DEFAULT_MODEL_ID = FORECAST_MODELS[0].id;

export function forecastModelById(id: string): ForecastModelDef {
  return FORECAST_MODELS.find(m => m.id === id) ?? FORECAST_MODELS[0];
}
