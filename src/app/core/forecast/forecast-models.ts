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
  /** Native grid spacing (km) of the near-surface fields, for display ("9 km", "13 km"). */
  gridKm: number;
  /**
   * The spacing (km) of the field as it is published, which decides the ground it is drawn against: how coarse the ground seen by the picture is,
   * and so how much the 90 m terrain correction has to add. Equal to gridKm where the model is published on its own grid (ECMWF IFS, UK Met Office,
   * 0.1 degree); GFS has 13 km surface fields but is published on the 0.25 degree grid of the two AI models (28 km ground).
   */
  groundKm: number;
  baseUrl: string;
  /** The centre that runs it: the model's colour follows this (blue ECMWF, violet NOAA, green Met Office). */
  centre: 'ECMWF' | 'NOAA' | 'Met Office' | 'DWD' | 'Kralveth';
  /** An AI model (learned from past weather) rather than a physics model: its colour is the lighter shade and its chart line is dashed. */
  ai: boolean;
  /**
   * The datasets of Open-Meteo the model is built from. Each has a status file (api.open-meteo.com/data/<dataset>/static/meta.json) that names
   * its newest run; the newest run all of them have is the model's latest.
   */
  datasets: readonly string[];
  /** Its name in Open-Meteo's forecast API (the meteogram's data) and the same name in the API's per-model status file. */
  apiId: string;
  /** How far the published forecast reaches, in hours after the run began (the model's own manifest says the same for the run on screen). */
  reachHours: number;
}

export const PAGES = 'https://gowthamgta.github.io/Atmos';

export const FORECAST_MODELS: readonly ForecastModelDef[] = [
  {
    id: 'global', label: 'Kralveth AI', short: 'Kralveth AI', resolution: 'Kralveth AI: 9 km (0.1°) Day 1 + 25 km Days 2–6 worldwide full-bundle forecast',
    gridKm: 25, groundKm: 28, baseUrl: `${PAGES}/global`, centre: 'Kralveth', ai: true,
    datasets: ['ecmwf_ifs025', 'ecmwf_aifs025_single'], apiId: 'ecmwf_ifs025', reachHours: 144,
  },
];

export const DEFAULT_MODEL_ID = FORECAST_MODELS[0].id;

/** Worldwide forecast definition (ECMWF 9km Day 1 + ECMWF AIFS 25km Days 2–5). */
export const GLOBAL_MODEL_DEF: ForecastModelDef = FORECAST_MODELS[0];

export function forecastModelById(id: string): ForecastModelDef {
  return FORECAST_MODELS.find(m => m.id === id) ?? FORECAST_MODELS[0];
}

/** What the meteogram needs to name a model it draws. */
export interface PointModelDef {
  id: string;
  label: string;
  short: string;
  ai: boolean;
}

/** Models compared in the meteogram alongside the map models, with Open-Meteo's API names. */
export const POINT_ONLY_MODELS: readonly (PointModelDef & { apiId: string })[] = [
  { id: 'ecmwf_ifs', label: 'ECMWF IFS', short: 'ECMWF', ai: false, apiId: 'ecmwf_ifs' },
  { id: 'aifs', label: 'ECMWF AIFS', short: 'AIFS', ai: true, apiId: 'ecmwf_aifs025_single' },
  { id: 'gfs', label: 'NOAA GFS', short: 'GFS', ai: false, apiId: 'gfs_global' },
  { id: 'icon', label: 'DWD ICON', short: 'ICON', ai: false, apiId: 'icon_global' },
  { id: 'ukmo', label: 'UK Met Office', short: 'UKMO', ai: false, apiId: 'ukmo_global_deterministic_10km' },
  { id: 'gem', label: 'GEM Canada', short: 'GEM', ai: false, apiId: 'gem_global' },
  { id: 'jma', label: 'JMA Japan', short: 'JMA', ai: false, apiId: 'jma_gsm' },
  { id: 'arpege', label: 'Météo-France', short: 'ARPEGE', ai: false, apiId: 'meteofrance_arpege_world' },
  { id: 'cma', label: 'CMA China', short: 'CMA', ai: false, apiId: 'cma_grapes_global' },
];

/** The models of the meteogram's comparison: the map's models, then the others. */
export const POINT_MODELS: readonly PointModelDef[] = [...FORECAST_MODELS, ...POINT_ONLY_MODELS];

/** True for a model that can be shown on the map (the point-only models cannot). */
export function isMapModel(id: string): boolean {
  return FORECAST_MODELS.some(m => m.id === id);
}

export function pointModelById(id: string): PointModelDef {
  return POINT_MODELS.find(m => m.id === id) ?? FORECAST_MODELS[0];
}

/** The model's colour as a CSS value (the tokens of styles.css, so it follows the theme). */
export function modelColor(id: string): string {
  return `var(--m-${id})`;
}
