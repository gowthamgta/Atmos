/**
 * Colour scales for weather fields: temperature, wind, rain, rain accumulation, and humidity.
 * Each list runs from the low end to the high end of its scale and is spread across the layer's
 * own display range (see forecast-layers.ts).
 */

/**
 * Temperature in °C, pinned to degrees: below 30 °C green, above 30 °C transitioning from yellow to red
 * (the owner, 6 Nov 2026: "below 30 degree apply that green and so on above 30 make the yellow to red color");
 * sub-zero and upper-air temperatures use cool blues and purples held to -100 °C.
 */
const TEMP_ANCHORS: readonly [number, string][] = [
  [-100, '#734669'], [-70, '#734669'], [-55, '#caacc3'], [-40, '#a24691'], [-20, '#9589d3'], [-15, '#96d1d8'], [-10, '#81ccc5'],
  [-5, '#67b4ba'], [0, '#5f8fc5'], [5, '#2ea879'], [10, '#16a34a'], [15, '#15803d'], [20, '#16a34a'], [25, '#22c55e'], [28, '#4ade80'],
  [30, '#eab308'], [33, '#f59e0b'], [36, '#f97316'], [40, '#ef4444'], [45, '#b91c1c'], [50, '#5a1a06'],
];

/** Colour of a temperature (°C), as "#rrggbb". */
export function tempColour(c: number): string {
  return colourAt(TEMP_ANCHORS, c);
}

/** Temperature colours as evenly spaced stops over a display range in °C, so a temperature has the same colour on every layer and level. */
export function tempStops(min: number, max: number): string[] {
  return pinnedStops(TEMP_ANCHORS, min, max, (max - min) / 128);
}


/**
 * Wind speed in m/s, pinned to values as Windy does (its own scale: blue-violet calm, blue 1, teal 3, sea-green 5, green 7-9, olive 11,
 * ochre 13, brown-red 15, wine 17, magenta 19, violet 21, then blues, purple and pale for jet-stream speeds), so a speed has the same colour
 * at every level (the owner, 6 Nov 2026, comparing Windy's 700 hPa wind with ours).
 */
const WIND_ANCHORS: readonly [number, string][] = [
  [0, '#6271b7'], [1, '#39619f'], [3, '#4a94a9'], [5, '#4d8d7b'], [7, '#53a553'], [9, '#359f35'], [11, '#a79d51'], [13, '#9f7f3a'],
  [15, '#a16c5c'], [17, '#813a4e'], [19, '#af5088'], [21, '#754a93'], [24, '#6d61a3'], [27, '#44698d'], [29, '#5c9098'], [36, '#7d44a5'],
  [46, '#e7d7d7'], [51, '#dbd487'], [77, '#cdca70'], [104, '#808080'],
];

/** Windy's wind colours as evenly spaced stops over a display range in m/s (the layer's min and max). */
export function windStops(min: number, max: number): string[] {
  return pinnedStops(WIND_ANCHORS, min, max, (max - min) / 64);
}

/**
 * Rain accumulation in mm with Windy's colours (the owner, 6 Nov 2026: reverted to the old palette,
 * with sky blue #38bdf8 at the base: sky blue to 3 mm, blue 5.5, cyan at 10, aqua at 16,
 * aqua-green at 25, lime at 50, orange at 100, red 173, dark red at 300).
 */
const RAIN_ACCUMULATION_ANCHORS: readonly [number, string][] = [
  [0, '#38bdf8'],
  [3, '#38bdf8'],
  [5.5, '#3f7bea'],
  [10, '#29bced'],
  [16, '#25d2d1'],
  [25, '#29e6b0'],
  [50, '#c1ee34'],
  [100, '#f7a82b'],
  [173, '#d33104'],
  [300, '#8a0b03'],
];

/**
 * Rain rate in mm/h in the accumulation's colours (sky blue to 0.5 mm/h, blue 1, cyan 2,
 * aqua 3, aqua-green 5, lime 10, orange 20, red 35, dark red 50).
 */
const RAIN_ANCHORS: readonly [number, string][] = [
  [0, '#38bdf8'],
  [0.5, '#38bdf8'],
  [1, '#3f7bea'],
  [2, '#29bced'],
  [3, '#25d2d1'],
  [5, '#29e6b0'],
  [10, '#c1ee34'],
  [20, '#f7a82b'],
  [35, '#d33104'],
  [50, '#8a0b03'],
];

/** The palette stops for a value-pinned scale drawn with a gamma (stop i sits at min + (max - min) * (i / n)^(1 / gamma), as the shader reads). */
function gammaStops(anchors: readonly [number, string][], min: number, max: number, gamma: number): string[] {
  const n = 64;
  return Array.from({ length: n + 1 }, (_, i) => colourAt(anchors, min + (max - min) * Math.pow(i / n, 1 / gamma)));
}

export const RAIN_MAX = 50;
export const RAIN_GAMMA = 0.4;
export const RAIN_ACCUMULATION_GAMMA = 0.27;
export const WINDY_RAIN_RATE = gammaStops(RAIN_ANCHORS, 0, RAIN_MAX, RAIN_GAMMA);
export const WINDY_RAIN_ACCUMULATION = gammaStops(RAIN_ACCUMULATION_ANCHORS, 0, 300, RAIN_ACCUMULATION_GAMMA);

export const WINDY_WIND = windStops(0, 20);

/**
 * Relative humidity (the owner, 6 Nov 2026:
 * under 30 % orange #de8e1f, 40 to 60 % green, above 60 % blue).
 */
const HUMIDITY_ANCHORS: readonly [number, string][] = [
  [0, '#de8e1f'],
  [25, '#de8e1f'],
  [30, '#de8e1f'],
  [35, '#84cc16'],
  [40, '#22c55e'],
  [50, '#16a34a'],
  [60, '#16a34a'],
  [65, '#3b82f6'],
  [75, '#2563eb'],
  [85, '#1d4ed8'],
  [100, '#1e3a8a'],
];

/** The humidity palette as evenly spaced stops (every 5 %) over a display range, so each colour stays at its humidity whatever the range. */
export function humidityStops(min: number, max: number): string[] {
  return pinnedStops(HUMIDITY_ANCHORS, min, max, 5);
}

/** Colours pinned to values (`anchors`, rising), sampled every `step` from min to max: evenly spaced stops for the palette texture. */
function pinnedStops(anchors: readonly [number, string][], min: number, max: number, step: number): string[] {
  const stops: string[] = [];
  for (let v = min; v <= max + 1e-9; v += step) stops.push(colourAt(anchors, v));
  return stops;
}

/** The colour at value `v` between the anchors around it (the first and last hold beyond the ends). */
function colourAt(anchors: readonly [number, string][], v: number): string {
  const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const i = anchors.findIndex(([a]) => a >= v);
  if (i < 0) return anchors[anchors.length - 1][1];
  if (i === 0) return anchors[0][1];
  const [v0, c0] = anchors[i - 1];
  const [v1, c1] = anchors[i];
  const t = (v - v0) / (v1 - v0);
  const [a, b] = [hex(c0), hex(c1)];
  return '#' + a.map((x, k) => Math.round(x + (b[k] - x) * t).toString(16).padStart(2, '0')).join('');
}

export const WINDY_HUMIDITY = humidityStops(20, 100);
