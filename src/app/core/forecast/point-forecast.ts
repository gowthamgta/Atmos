import { degToCompass } from '../domain/models/compass';
import { Level, LEVEL_KM } from './forecast-layers';
import { PointTerrain, TerrainContext, TerrainMode, applyTerrain } from './terrain-correction';

/** Fields read for the click card at the ground. */
export const SURFACE_INSPECT_VARS = [
  't2m', 'feels', 'dew', 'rh', 'u10', 'v10', 'gust', 'precip', 'cloud', 'cloud_low', 'cloud_mid', 'cloud_high', 'vis', 'msl', 'cape',
  'rain24', 'tmin24', 'tmax24', 'li', 'cin', 'tcwv',
] as const;

/** Every variable the card needs for this altitude (the ground fields, plus that level's when one is selected). */
export function inspectVars(level: Level): string[] {
  const vars: string[] = [...SURFACE_INSPECT_VARS, 'u850', 'v850']; // 850 hPa wind drives the rain/low-cloud lift
  if (level !== 'surface') vars.push(`t${level}`, `rh${level}`, `u${level}`, `v${level}`, `gh${level}`, `w${level}`, `vo${level}`, `dv${level}`);
  return [...new Set(vars)];
}

/** The wind used for orographic lift at a point: 850 hPa when available, else 10 m (same choice as the map). */
export function liftWindAt(values: Record<string, number>): [number, number] | null {
  const ok = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && !Number.isNaN(a) && !Number.isNaN(b);
  if (ok(values['u850'], values['v850'])) return [values['u850'], values['v850']];
  if (ok(values['u10'], values['v10'])) return [values['u10'], values['v10']];
  return null;
}

export interface PointRow {
  id: string;
  label: string;
  /** Preformatted value including the unit. Empty for a heading row. */
  text: string;
  /** True when the 1 km terrain correction was applied. */
  terrainAdjusted: boolean;
  /** A section heading rather than a value. */
  heading?: boolean;
}

export interface PointForecast {
  lat: number;
  lon: number;
  district: string | null;
  state: string | null;
  /** Ground height from the 1 km terrain (null while it is unavailable). */
  elevationM: number | null;
  timeMs: number;
  rows: PointRow[];
}

/** Blend two time steps; if one side has no data the other is used. */
export function blendTime(a: number, b: number, mix: number): number {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return a * (1 - mix) + b * mix;
}

/** Meteorological wind: speed in m/s and the direction it blows FROM, in degrees. */
export function windFromUV(u: number, v: number): { speedMs: number; fromDeg: number } {
  const speedMs = Math.hypot(u, v);
  const fromDeg = (270 - (Math.atan2(v, u) * 180) / Math.PI + 360) % 360;
  return { speedMs, fromDeg };
}

const fmt = (v: number, digits = 0): string => (Number.isNaN(v) ? '–' : v.toFixed(digits));
/** A value with its unit, or just a dash when the model does not provide it. */
const withUnit = (v: number, digits: number, unit: string): string => (Number.isNaN(v) ? '–' : `${v.toFixed(digits)} ${unit}`);
const KMH_PER_MS = 3.6;

function rainText(mmPerHour: number): string {
  return withUnit(mmPerHour, mmPerHour < 10 ? 1 : 0, 'mm/h');
}

function windText(u: number, v: number, factor = 1): string {
  const w = windFromUV(u, v);
  return Number.isNaN(w.speedMs) ? '–' : `${fmt(w.speedMs * factor * KMH_PER_MS)} km/h from ${degToCompass(w.fromDeg)}`;
}

/**
 * Turns blended raw field values into display rows, moving the near-surface ones from the model's ground to the real
 * 1 km ground exactly as the map does. `terrain` is null while the terrain is unavailable (model values are shown).
 */
export function buildPointRows(
  values: Record<string, number>,
  terrain: PointTerrain | null,
  level: Level = 'surface',
  where?: { timeMs: number; lat: number; lon: number },
): PointRow[] {
  const v = (id: string): number => values[id] ?? NaN;
  const ctx: TerrainContext | null = terrain ? { terrain, liftWind: liftWindAt(values), ...where } : null;
  const adjust = (mode: TerrainMode, x: number) => applyTerrain(mode, x, ctx);
  const adjusted = ctx !== null;
  const windFactor = Number.isNaN(v('u10')) ? 1 : adjust('wind', 1); // the same factor scales the 10 m wind and gusts
  const rows: PointRow[] = [
    { id: 'temp', label: 'Temperature', text: withUnit(adjust('temperature', v('t2m')), 1, '°C'), terrainAdjusted: adjusted },
    { id: 'feels', label: 'Feels like', text: withUnit(adjust('temperature', v('feels')), 1, '°C'), terrainAdjusted: adjusted },
    { id: 'dew', label: 'Dew point', text: withUnit(adjust('dewpoint', v('dew')), 1, '°C'), terrainAdjusted: adjusted },
    { id: 'humidity', label: 'Humidity', text: withUnit(adjust('humidity', v('rh')), 0, '%'), terrainAdjusted: adjusted },
    { id: 'wind', label: 'Wind', text: windText(v('u10'), v('v10'), windFactor), terrainAdjusted: adjusted },
    { id: 'gust', label: 'Gusts', text: withUnit(adjust('wind', v('gust')) * KMH_PER_MS, 0, 'km/h'), terrainAdjusted: adjusted },
    { id: 'rain', label: 'Rain', text: rainText(adjust('rain', v('precip'))), terrainAdjusted: adjusted && ctx?.liftWind !== null },
    { id: 'clouds', label: 'Clouds', text: withUnit(v('cloud'), 0, '%'), terrainAdjusted: false },
  ];
  // the lowest and highest temperature of the next 24 h, right under the temperature row
  const extremes: [string, string, number][] = [['tmin24', 'Lowest, next 24 h', v('tmin24')], ['tmax24', 'Highest, next 24 h', v('tmax24')]];
  rows.splice(1, 0, ...extremes.filter(([, , x]) => !Number.isNaN(x)).map(([id, label, x]) => (
    { id, label, text: withUnit(adjust('temperature', x), 1, '°C'), terrainAdjusted: adjusted })));
  if (!Number.isNaN(v('rain24'))) {
    // the row after the rain one: the 24 h total
    rows.splice(rows.findIndex(r => r.id === 'rain') + 1, 0, {
      id: 'rain24', label: 'Rain, next 24 h', text: withUnit(adjust('rain', v('rain24')), v('rain24') < 10 ? 1 : 0, 'mm'), terrainAdjusted: adjusted && ctx?.liftWind !== null,
    });
  }
  const layers = [adjust('lowcloud', v('cloud_low')), v('cloud_mid'), v('cloud_high')];
  if (layers.some(x => !Number.isNaN(x))) {
    rows.push({ id: 'cloudlayers', label: 'Low / mid / high', text: `${layers.map(x => fmt(x)).join(' / ')} %`, terrainAdjusted: false });
  }
  if (!Number.isNaN(v('vis'))) {
    rows.push({ id: 'vis', label: 'Visibility', text: withUnit(v('vis'), v('vis') < 10 ? 1 : 0, 'km'), terrainAdjusted: false });
  }
  rows.push(
    { id: 'pressure', label: 'Pressure', text: withUnit(v('msl'), 0, 'hPa'), terrainAdjusted: false },
    { id: 'cape', label: 'Thunderstorm energy', text: withUnit(v('cape'), 0, 'J/kg'), terrainAdjusted: false },
  );
  if (!Number.isNaN(v('tcwv'))) rows.push({ id: 'tcwv', label: 'Atmospheric moisture', text: withUnit(adjust('column', v('tcwv')), 0, 'kg/m²'), terrainAdjusted: adjusted });
  if (!Number.isNaN(v('cin'))) rows.push({ id: 'cin', label: 'Convective inhibition', text: withUnit(v('cin'), 0, 'J/kg'), terrainAdjusted: false });
  if (!Number.isNaN(v('li'))) rows.push({ id: 'li', label: 'Lifted index', text: withUnit(v('li'), 1, '°C'), terrainAdjusted: false });

  if (level !== 'surface') {
    const alt = `${level} hPa · about ${LEVEL_KM[level]} km`;
    rows.push({ id: 'level-heading', label: `At ${alt}`, text: '', terrainAdjusted: false, heading: true });
    rows.push(
      { id: 'lvl-temp', label: 'Temperature', text: withUnit(v(`t${level}`), 1, '°C'), terrainAdjusted: false },
      { id: 'lvl-humidity', label: 'Humidity', text: withUnit(v(`rh${level}`), 0, '%'), terrainAdjusted: false },
      { id: 'lvl-wind', label: 'Wind', text: windText(v(`u${level}`), v(`v${level}`)), terrainAdjusted: false },
      { id: 'lvl-height', label: 'Height', text: withUnit(v(`gh${level}`), 0, 'm'), terrainAdjusted: false },
    );
    const aloft: [string, string, string, number, string][] = [
      ['lvl-w', 'Vertical motion (+ rising)', `w${level}`, 100, 'cm/s'], ['lvl-vo', 'Vorticity', `vo${level}`, 1, '×10⁻⁵ /s'], ['lvl-dv', 'Divergence', `dv${level}`, 1, '×10⁻⁵ /s'],
    ];
    for (const [id, label, key, scale, unit] of aloft) {
      if (!Number.isNaN(v(key))) rows.push({ id, label, text: withUnit(v(key) * scale, 1, unit), terrainAdjusted: false });
    }
  }
  return rows;
}


/** The click-card row that shows each layer's value at the ground. */
const LAYER_ROW: Record<string, string> = {
  temp: 'temp', tmin24: 'tmin24', tmax24: 'tmax24', feels: 'feels', dew: 'dew', wind: 'wind', gust: 'gust', humidity: 'humidity', rain: 'rain', rain24: 'rain24',
  tcwv: 'tcwv', vis: 'vis', pressure: 'pressure', cape: 'cape', li: 'li', cin: 'cin',
};
/** ...and at a pressure level (only some layers can be shown there). */
const LAYER_LEVEL_ROW: Record<string, string> = { temp: 'lvl-temp', humidity: 'lvl-humidity', wind: 'lvl-wind', pressure: 'lvl-height', vertical: 'lvl-w', vorticity: 'lvl-vo', divergence: 'lvl-dv' };

/**
 * Only the value of the layer that is on the map: one row, or none when the model has no value for it. At a pressure level the
 * row is the level's value (labelled with the level). With no layer selected every row is kept.
 */
export function rowsForLayer(rows: PointRow[], layerId: string | null, level: Level = 'surface'): PointRow[] {
  if (!layerId) return rows;
  const aloft = level !== 'surface' ? LAYER_LEVEL_ROW[layerId] : undefined;
  const id = aloft ?? LAYER_ROW[layerId];
  const row = id ? rows.find(r => r.id === id && !r.heading) : undefined;
  if (!row) return [];
  return [aloft ? { ...row, label: `${row.label} · ${level} hPa` } : row];
}
