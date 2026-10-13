import { degToCompass } from '../domain/models/compass';
import { METRIC, TEMP_LABEL, Units, formatPressure, formatRain, formatWind, tempFromC } from '../units/units';
import { Level, LEVEL_KM } from './forecast-layers';
import { PointTerrain, TerrainContext, TerrainMode, applyTerrain } from './terrain-correction';

/** Fields read for the click card at the ground. */
export const SURFACE_INSPECT_VARS = [
  't2m', 'feels', 'dew', 'rh', 'u10', 'v10', 'gust', 'precip', 'cloud', 'cloud_low', 'cloud_mid', 'cloud_high', 'vis', 'msl', 'cape',
  'rain24', 'raintot', 'tmin24', 'tmax24', 'li', 'cin', 'tcwv',
] as const;

/** Every variable the card needs for this altitude (the ground fields, plus that level's when one is selected). */
export function inspectVars(level: Level): string[] {
  const vars: string[] = [...SURFACE_INSPECT_VARS, 'u850', 'v850']; // 850 hPa wind drives the rain/low-cloud lift
  if (level !== 'surface') vars.push(`t${level}`, `rh${level}`, `u${level}`, `v${level}`, `gh${level}`, `w${level}`, `vo${level}`, `dv${level}`);
  return [...new Set(vars)];
}

/** What the closed place card shows: the temperature with its feels-like, the wind, the humidity, and the sky (rain and cloud). */
export const SUMMARY_VARS = ['t2m', 'feels', 'rh', 'u10', 'v10', 'precip', 'cloud'] as const;

/**
 * The few variables worth downloading before anyone opens "All values": the summary, plus whatever the layer on the map needs (its value is
 * in the bubble beside the pin). A layer whose rain is corrected for the hills also needs the 850 hPa wind that lifts the air. Every picture
 * costs about 100 KB, so a place card that asked for the full list on every click and every step of the time bar fetched some 70 of them.
 */
export function summaryVars(layer: { varId: string; varId2?: string; terrain: string | null } | null): string[] {
  const vars: string[] = [...SUMMARY_VARS];
  if (layer) {
    if (layer.varId !== 'extreme') vars.push(layer.varId);
    if (layer.varId2) vars.push(layer.varId2);
    if (layer.terrain === 'rain') vars.push('u850', 'v850');
  }
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
  /** True when the 90 m terrain correction was applied. */
  terrainAdjusted: boolean;
  /** A section heading rather than a value. */
  heading?: boolean;
}

export interface PointForecast {
  lat: number;
  lon: number;
  district: string | null;
  state: string | null;
  /** Ground height from the 90 m terrain (null while it is unavailable). */
  elevationM: number | null;
  timeMs: number;
  rows: PointRow[];
  /** The blended raw values (°C, m/s, mm, %...) the rows were made from, for the weather picture and the big numbers of the place card. */
  values: Record<string, number>;
  /** True when every variable was read (the full list of values); false when only the summary was, and rows beyond it are empty. */
  detailed: boolean;
  /** The rain period (epoch ms) the "rain in the chosen period" value was worked out for; absent when that value is not in the rows. */
  period?: { from: number; to: number };
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

/** A temperature in °C as "27.2 °C" or "81.0 °F", by the chosen units. */
const tempText = (c: number, units: Units, digits = 1): string => (Number.isNaN(c) ? '–' : `${tempFromC(c, units.temp).toFixed(digits)} ${TEMP_LABEL[units.temp]}`);

function windText(u: number, v: number, factor = 1, units: Units = METRIC): string {
  const w = windFromUV(u, v);
  return Number.isNaN(w.speedMs) ? '–' : `${formatWind(w.speedMs * factor, units)} from ${degToCompass(w.fromDeg)}`;
}

/**
 * Turns blended raw field values into display rows, moving the near-surface ones from the model's ground to the real
 * 90 m ground exactly as the map does. `terrain` is null while the terrain is unavailable (model values are shown).
 */
export function buildPointRows(
  values: Record<string, number>,
  terrain: PointTerrain | null,
  level: Level = 'surface',
  where?: { timeMs: number; lat: number; lon: number },
  units: Units = METRIC,
): PointRow[] {
  const v = (id: string): number => values[id] ?? NaN;
  const ctx: TerrainContext | null = terrain ? { terrain, liftWind: liftWindAt(values), ...where } : null;
  const adjust = (mode: TerrainMode, x: number) => applyTerrain(mode, x, ctx);
  const adjusted = ctx !== null;
  const windFactor = Number.isNaN(v('u10')) ? 1 : adjust('wind', 1); // the same factor scales the 10 m wind and gusts
  const rows: PointRow[] = [
    { id: 'temp', label: 'Temperature', text: tempText(adjust('temperature', v('t2m')), units), terrainAdjusted: adjusted },
    { id: 'feels', label: 'Feels like', text: tempText(adjust('temperature', v('feels')), units), terrainAdjusted: adjusted },
    { id: 'dew', label: 'Dew point', text: tempText(adjust('dewpoint', v('dew')), units), terrainAdjusted: adjusted },
    { id: 'humidity', label: 'Humidity', text: withUnit(adjust('humidity', v('rh')), 0, '%'), terrainAdjusted: adjusted },
    { id: 'wind', label: 'Wind', text: windText(v('u10'), v('v10'), windFactor, units), terrainAdjusted: adjusted },
    { id: 'gust', label: 'Gusts', text: formatWind(adjust('wind', v('gust')), units), terrainAdjusted: adjusted },
    { id: 'rain', label: 'Rain', text: formatRain(adjust('rain', v('precip')), units, true), terrainAdjusted: adjusted && ctx?.liftWind !== null },
    { id: 'clouds', label: 'Clouds', text: withUnit(v('cloud'), 0, '%'), terrainAdjusted: false },
  ];
  // the lowest and highest temperature of the next 24 h, right under the temperature row
  const extremes: [string, string, number][] = [['tmin24', 'Lowest, next 24 h', v('tmin24')], ['tmax24', 'Highest, next 24 h', v('tmax24')]];
  rows.splice(1, 0, ...extremes.filter(([, , x]) => !Number.isNaN(x)).map(([id, label, x]) => (
    { id, label, text: tempText(adjust('temperature', x), units), terrainAdjusted: adjusted })));
  if (!Number.isNaN(v('rain24'))) {
    // the row after the rain one: the 24 h total
    rows.splice(rows.findIndex(r => r.id === 'rain') + 1, 0, {
      id: 'rain24', label: 'Rain, next 24 h', text: formatRain(adjust('rain', v('rain24')), units), terrainAdjusted: adjusted && ctx?.liftWind !== null,
    });
  }
  if (!Number.isNaN(v('raintot'))) {
    // the total since the model run began, after the 24 h row
    const after = rows.findIndex(r => r.id === 'rain24') >= 0 ? rows.findIndex(r => r.id === 'rain24') : rows.findIndex(r => r.id === 'rain');
    rows.splice(after + 1, 0, {
      id: 'raintot', label: 'Rain, total so far', text: formatRain(adjust('rain', v('raintot')), units), terrainAdjusted: adjusted && ctx?.liftWind !== null,
    });
  }
  if (!Number.isNaN(v('rainrange'))) {
    // the rain in the period chosen with the rain accumulation slider
    rows.splice(rows.findIndex(r => r.id === 'rain') + 1, 0, {
      id: 'rainrange', label: 'Rain in the chosen period', text: formatRain(adjust('rain', v('rainrange')), units), terrainAdjusted: adjusted && ctx?.liftWind !== null,
    });
  }
  if (!Number.isNaN(v('extreme'))) {
    const prob = Math.round(Math.min(100, Math.max(0, v('extreme'))));
    rows.splice(rows.findIndex(r => r.id === 'rain') + 1, 0, {
      id: 'extreme', label: 'Rain probability, next 24 h', text: `${prob} %`, terrainAdjusted: false,
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
    { id: 'pressure', label: 'Pressure', text: formatPressure(v('msl'), units), terrainAdjusted: false },
    { id: 'cape', label: 'Thunderstorm energy', text: withUnit(v('cape'), 0, 'J/kg'), terrainAdjusted: false },
  );
  if (!Number.isNaN(v('tcwv'))) rows.push({ id: 'tcwv', label: 'Atmospheric moisture', text: withUnit(adjust('column', v('tcwv')), 0, 'kg/m²'), terrainAdjusted: adjusted });
  if (!Number.isNaN(v('cin'))) rows.push({ id: 'cin', label: 'Convective inhibition', text: withUnit(v('cin'), 0, 'J/kg'), terrainAdjusted: false });
  if (!Number.isNaN(v('li'))) rows.push({ id: 'li', label: 'Lifted index', text: withUnit(v('li'), 1, '°C'), terrainAdjusted: false });

  if (level !== 'surface') {
    const alt = `${level} hPa · about ${LEVEL_KM[level]} km`;
    rows.push({ id: 'level-heading', label: `At ${alt}`, text: '', terrainAdjusted: false, heading: true });
    rows.push(
      { id: 'lvl-temp', label: 'Temperature', text: tempText(v(`t${level}`), units), terrainAdjusted: false },
      { id: 'lvl-humidity', label: 'Humidity', text: withUnit(v(`rh${level}`), 0, '%'), terrainAdjusted: false },
      { id: 'lvl-wind', label: 'Wind', text: windText(v(`u${level}`), v(`v${level}`), 1, units), terrainAdjusted: false },
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
  temp: 'temp', tmin24: 'tmin24', tmax24: 'tmax24', feels: 'feels', dew: 'dew', wind: 'wind', gust: 'gust', humidity: 'humidity', rain: 'rain', rain24: 'rain24', raintot: 'rainrange', extreme: 'extreme',
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
