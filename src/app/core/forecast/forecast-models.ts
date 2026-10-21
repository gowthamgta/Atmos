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
  centre: 'ECMWF' | 'NOAA' | 'Met Office';
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
    id: 'ecmwf_ifs', label: 'ECMWF IFS', short: 'ECMWF', resolution: '9 km, all India', gridKm: 9, groundKm: 9, baseUrl: `${PAGES}/ecmwf_ifs`,
    centre: 'ECMWF', ai: false, datasets: ['ecmwf_ifs', 'ecmwf_ifs025'], apiId: 'ecmwf_ifs', reachHours: 144,
  },
  {
    id: 'ukmo', label: 'UK Met Office', short: 'UKMO', resolution: '10 km, all India', gridKm: 10, groundKm: 10, baseUrl: `${PAGES}/ukmo`,
    centre: 'Met Office', ai: false, datasets: ['ukmo_global_deterministic_10km'], apiId: 'ukmo_global_deterministic_10km', reachHours: 60,
  },
  {
    id: 'gfs', label: 'NOAA GFS', short: 'GFS', resolution: '13 km surface, all India', gridKm: 13, groundKm: 28, baseUrl: `${PAGES}/gfs`,
    centre: 'NOAA', ai: false, datasets: ['ncep_gfs013', 'ncep_gfs025'], apiId: 'gfs_global', reachHours: 384,
  },
  {
    id: 'aigfs', label: 'NOAA AIGFS', short: 'AIGFS', resolution: '25 km, all India', gridKm: 25, groundKm: 28, baseUrl: `${PAGES}/aigfs`,
    centre: 'NOAA', ai: true, datasets: ['ncep_aigfs025'], apiId: 'ncep_aigfs025', reachHours: 384,
  },
  {
    id: 'aifs', label: 'ECMWF AIFS', short: 'AIFS', resolution: '25 km, all India', gridKm: 25, groundKm: 28, baseUrl: `${PAGES}/aifs`,
    centre: 'ECMWF', ai: true, datasets: ['ecmwf_aifs025_single'], apiId: 'ecmwf_aifs025_single', reachHours: 360,
  },
];

export const DEFAULT_MODEL_ID = FORECAST_MODELS[0].id;

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

/**
 * The AtmosIQ Blend: the corrected models weighted by how right each has been lately (core/meteogram/blend.ts). It is not a map model, only a
 * line and a row in the meteogram's comparison.
 */
export const BLEND_MODEL: PointModelDef = { id: 'blend', label: 'AtmosIQ Blend', short: 'Blend', ai: false };

/**
 * Models compared in the meteogram that are not on the map, with Open-Meteo's names: DWD ICON scores among the best at the South Indian airports
 * (pipeline/verify.py) and is one of the Blend's models.
 */
export const POINT_ONLY_MODELS: readonly (PointModelDef & { apiId: string })[] = [
  { id: 'icon', label: 'DWD ICON', short: 'ICON', ai: false, apiId: 'icon_global' },
];

/** The models of the meteogram's comparison: the Blend first, then the map's models, then the others. */
export const POINT_MODELS: readonly PointModelDef[] = [BLEND_MODEL, ...FORECAST_MODELS, ...POINT_ONLY_MODELS];

/** True for a model that can be shown on the map (the Blend and the point-only models cannot). */
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
