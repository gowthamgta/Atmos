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
   * sets how much the 1 km terrain correction has to add.
   */
  gridKm: number;
  baseUrl: string;
}

const PAGES = 'https://gowthamgta.github.io/Atmos';

export const FORECAST_MODELS: readonly ForecastModelDef[] = [
  { id: 'ecmwf_ifs', label: 'ECMWF IFS', resolution: '9 km', gridKm: 9, baseUrl: `${PAGES}/ecmwf_ifs` },
  { id: 'ecmwf_aifs', label: 'ECMWF AIFS (AI)', resolution: '28 km', gridKm: 28, baseUrl: `${PAGES}/ecmwf_aifs` },
  { id: 'gfs', label: 'NOAA GFS', resolution: '13–28 km', gridKm: 13, baseUrl: `${PAGES}/gfs` },
  { id: 'ukmo', label: 'UK Met Office', resolution: '10 km', gridKm: 10, baseUrl: `${PAGES}/ukmo` },
  { id: 'dwd_icon', label: 'DWD ICON', resolution: '13 km', gridKm: 13, baseUrl: `${PAGES}/dwd_icon` },
  { id: 'arpege', label: 'Météo-France ARPEGE', resolution: '28 km', gridKm: 28, baseUrl: `${PAGES}/arpege` },
  { id: 'gdps', label: 'Canada GDPS', resolution: '15 km', gridKm: 15, baseUrl: `${PAGES}/gdps` },
  { id: 'cma_grapes', label: 'CMA GRAPES', resolution: '15 km', gridKm: 15, baseUrl: `${PAGES}/cma_grapes` },
  { id: 'jma_gsm', label: 'JMA GSM', resolution: '55 km', gridKm: 55, baseUrl: `${PAGES}/jma_gsm` },
  { id: 'aigfs', label: 'NCEP AI-GFS (AI)', resolution: '28 km', gridKm: 28, baseUrl: `${PAGES}/aigfs` },
];

export const DEFAULT_MODEL_ID = FORECAST_MODELS[0].id;

export function forecastModelById(id: string): ForecastModelDef {
  return FORECAST_MODELS.find(m => m.id === id) ?? FORECAST_MODELS[0];
}
