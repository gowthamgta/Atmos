import type { ForecastLayerDef, Level } from './forecast-layers';
import type { TerrainMode } from './terrain-correction';

/**
 * What a layer's colours mean, in words a visitor can check against the map: the quantity, how it relates to the time on the bar (a value at
 * that time, a rate over the hour before it, a total over the next 24 hours...), and where the layer is left transparent. These describe what the
 * pipeline (pipeline/derive.py, run.py) and the layer code do, so a change to either is a reason to change them (layer-notes.spec.ts keeps every
 * layer covered).
 */
export interface LayerNote {
  /** The quantity, and where in the air it is. */
  what: string;
  /** How the value relates to the time on the bar. */
  time: string;
  /** Where the layer is transparent beyond the common reason (a variable the model does not publish). */
  gaps?: string;
}

const INSTANT = 'The value at the time on the bar. Between two steps of the model the two values are blended in proportion to the time.';
const NEXT_24H = 'Counted over the 24 hours that START at the time on the bar, not the calendar day.';
const NO_PARTIAL = 'Transparent where the run ends before the 24 hours do, so a part of a day never passes for a whole one.';

export const LAYER_NOTES: Record<string, LayerNote> = {
  temp: { what: 'Air temperature 2 m above the ground.', time: INSTANT },
  tmin24: { what: 'The lowest 2 m air temperature of the next 24 hours.', time: NEXT_24H, gaps: NO_PARTIAL },
  tmax24: { what: 'The highest 2 m air temperature of the next 24 hours.', time: NEXT_24H, gaps: NO_PARTIAL },
  feels: { what: 'Feels-like temperature: the air temperature adjusted for humidity and wind (Steadman, as the Australian Bureau of Meteorology uses it).', time: INSTANT },
  dew: { what: 'Dew point 2 m above the ground: the temperature at which the air would be saturated.', time: INSTANT },
  wind: { what: 'Wind speed 10 m above the ground, from its east and north components. The streaks show the direction it blows to.', time: INSTANT },
  gust: { what: 'The strongest gust 10 m above the ground, as the model gives it.', time: 'The gust in the model\'s output interval that ends at the time on the bar; between steps the values are blended.' },
  humidity: { what: 'Relative humidity 2 m above the ground.', time: INSTANT },
  rain: {
    what: 'Rain rate: the mean rate over the interval before the time on the bar (one hour; three hours later in the forecast), as the model reports it.',
    time: 'Between two steps of the model the rates are blended in proportion to the time.',
  },
  rain24: { what: 'Rain accumulated over the next 24 hours.', time: NEXT_24H, gaps: NO_PARTIAL },
  raintot: {
    what: 'Rain accumulated over the period chosen on the time bar (the white stretch): the total at its end minus the total at its start, both counted from the start of the model run.',
    time: 'The two ends of the period are blended between model steps like any other time.',
  },
  extreme: {
    what: 'The IMD category of the rain in the next 24 hours that EVERY model reaching that far agrees on: heavy 64.5 mm, very heavy 115.6 mm, extremely heavy 204.5 mm or more.',
    time: `${NEXT_24H} Each model's picture nearest the time on the bar is used.`,
    gaps: `A colour appears only where all the models that cover the time give at least that category (the lowest of them is shown); with fewer than two models there is nothing to agree on. ${NO_PARTIAL}`,
  },
  tcwv: { what: 'Total water vapour in the whole column of air above the ground (precipitable water).', time: INSTANT },
  vis: { what: 'Horizontal visibility at the ground.', time: INSTANT },
  pressure: { what: 'Air pressure reduced to sea level (isobars are lines of equal value).', time: INSTANT },
  li: { what: 'Lifted index: the temperature of the surrounding air minus that of a lifted parcel at 500 hPa. Negative means unstable air, where storms can grow.', time: INSTANT },
  cin: { what: 'Convective inhibition: the energy a rising parcel of air must be given to get past the stable layer above the ground (its size, not a negative number).', time: INSTANT },
  cape: { what: 'Convective available potential energy: how much a rising parcel of air could gain from its warmth (the fuel of thunderstorms).', time: INSTANT },
  vertical: { what: 'Vertical air motion at the pressure level: positive is rising.', time: INSTANT },
  vorticity: { what: 'Relative vorticity at the pressure level, from the wind: positive is turning anticlockwise (cyclonic in the north).', time: INSTANT },
  divergence: { what: 'Horizontal divergence at the pressure level, from the wind: positive is air spreading out.', time: INSTANT },
};

/** What the layer is when it is drawn aloft (the quantity changes with it: pressure becomes the height of the surface). */
const ALOFT: Record<string, (level: Level) => string> = {
  temp: l => `Air temperature at ${l} hPa.`,
  wind: l => `Wind speed at ${l} hPa, from its east and north components.`,
  humidity: l => `Relative humidity at ${l} hPa.`,
  pressure: l => `Height of the ${l} hPa pressure surface above sea level (geopotential height); lines of equal height are drawn instead of isobars.`,
};

/** How each way of moving a field to the 90 m terrain changes it (the constants are in terrain-correction.ts). */
const GROUND: Record<TerrainMode, string> = {
  temperature: 'Moved from the model\'s own ground height to the 90 m terrain at 6.5 °C per km.',
  dewpoint: 'Moved from the model\'s own ground height to the 90 m terrain at 1.8 °C per km.',
  humidity: 'Moved from the model\'s ground height to the 90 m terrain: it follows the temperature and dew point changes, up to saturation.',
  wind: 'Faster on ridges and slower in valleys (between 0.6 and 1.6 times), and smoother over the sea near the coast.',
  rain: 'More where the wind is forced up the 90 m slopes and less in their lee, beyond what the model\'s own smoother terrain gives (between 0.35 and 2.6 times).',
  lowcloud: 'Follows the lift over the 90 m slopes, more gently than rain.',
  column: 'Less water vapour above ground that is higher than the model\'s.',
  solar: 'Slopes facing the sun get more, those facing away less.',
};

export interface LayerFacts {
  title: string;
  what: string;
  /** The unit and the range the colours cover. */
  scale: string;
  time: string;
  gaps: string;
  ground: string;
}

/** The facts of a layer as drawn at an altitude (the ground when `level` is 'surface'). `shown` is the layer as resolved for that altitude. */
export function layerFacts(base: ForecastLayerDef, shown: ForecastLayerDef, level: Level): LayerFacts {
  const note = LAYER_NOTES[base.id];
  const aloft = level !== 'surface' ? ALOFT[base.id]?.(level) : undefined;
  const scale = shown.displayScale ?? 1;
  const lo = +(shown.min * scale).toFixed(2);
  const hi = +(shown.max * scale).toFixed(2);
  const unit = shown.unit.startsWith('mm') ? 'mm' : shown.unit;
  const clear = shown.clearBelow > 0 ? ` Values under ${+(shown.clearBelow * scale).toFixed(2)} ${unit} are left transparent.` : '';
  const gaps = [note?.gaps, level !== 'surface' ? 'Where the ground is higher than this level the layer is shown faded: the level is underground there.' : undefined].filter(Boolean).join(' ');
  return {
    title: shown.label,
    what: aloft ?? note?.what ?? shown.label,
    scale: `${lo} to ${hi} ${unit}. A value beyond the ends of the scale takes the colour of that end.${clear}`,
    time: note?.time ?? INSTANT,
    gaps: `Transparent too where the model has no value for it (a variable it does not publish, or outside its area). ${gaps}`.trim(),
    ground: shown.terrain ? GROUND[shown.terrain] : level === 'surface' ? 'The model\'s value as it is: no correction for the 90 m terrain is made.' : 'The model\'s value at the pressure level: the 90 m terrain does not apply up there.',
  };
}
