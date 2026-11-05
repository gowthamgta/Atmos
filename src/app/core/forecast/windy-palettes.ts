/**
 * Colour scales taken from the legends of windy.com (read from its legend bars for temperature, wind, rain accumulation and
 * the radar): the same colour families, so the map reads like the one people already know. Each list runs from the low end to
 * the high end of its scale and is spread across the layer's own display range (see forecast-layers.ts).
 */

/** Temperature (Windy: purple for the cold end, through blue, green and yellow, to dark red for the heat). */
export const WINDY_TEMP = ['#96d1d8', '#66b3ba', '#5f8fc5', '#508c3d', '#7a921c', '#aba10e', '#dfb106', '#f39606', '#ec5e15', '#be4112', '#8a2a0a'];

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
 * Rain rate in mm/h with Windy's "Rain, thunder" colours, read from its legend (6 Nov 2026). Windy's scale is mm in 3 hours (blue to 3,
 * teal 5, green 7, lime 10, yellow 15, red 20, wine 25, magenta 30), so each colour sits at a third of Windy's amount here.
 */
const RAIN_ANCHORS: readonly [number, string][] = [
  [0, '#3b7ca2'], [0.5, '#3b7ca2'], [2 / 3, '#3b80a2'], [1, '#3a89a2'], [5 / 3, '#3a99a2'], [7 / 3, '#32a66f'], [17 / 6, '#4aa439'],
  [10 / 3, '#81a23b'], [5, '#a2a23b'], [20 / 3, '#a23c3b'], [25 / 3, '#ab366b'], [10, '#a43a9a'],
];

/**
 * Rain accumulation in mm with Windy's colours, read from its legend (6 Nov 2026): violet-blue to 3 mm, blue, cyan at 10, aqua-green at 25,
 * lime at 50, orange at 100, red, dark red at 300.
 */
const RAIN_ACCUMULATION_ANCHORS: readonly [number, string][] = [
  [0, '#4352bf'], [3, '#4352bf'], [5.5, '#3f7bea'], [10, '#29bced'], [16, '#25d2d1'], [25, '#29e6b0'], [50, '#c1ee34'], [100, '#f7a82b'],
  [173, '#d33104'], [300, '#8a0b03'],
];

/** The palette stops for a value-pinned scale drawn with a gamma (stop i sits at min + (max - min) * (i / n)^(1 / gamma), as the shader reads). */
function gammaStops(anchors: readonly [number, string][], min: number, max: number, gamma: number): string[] {
  const n = 64;
  return Array.from({ length: n + 1 }, (_, i) => colourAt(anchors, min + (max - min) * Math.pow(i / n, 1 / gamma)));
}

export const RAIN_MAX = 12;
export const RAIN_GAMMA = 0.5;
export const RAIN_ACCUMULATION_GAMMA = 0.27;
export const WINDY_RAIN_RATE = gammaStops(RAIN_ANCHORS, 0, RAIN_MAX, RAIN_GAMMA);
export const WINDY_RAIN_ACCUMULATION = gammaStops(RAIN_ACCUMULATION_ANCHORS, 0, 300, RAIN_ACCUMULATION_GAMMA);

export const WINDY_WIND = windStops(0, 20);

/**
 * Relative humidity (Windy: brown for the dry end, through olive and green, to teal and blue-slate for the moistest air), pinned to values:
 * blue only above 75 % (the owner, 5 Nov 2026: "make the humidity palette blue only after 75 percent").
 */
const HUMIDITY_ANCHORS: readonly [number, string][] = [
  [30, '#ae6e38'], [40, '#ae9338'], [50, '#69ae38'], [65, '#3caf74'], [75, '#36af94'], [80, '#389dae'], [85, '#3884ae'], [90, '#386fa6'], [100, '#384672'],
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

export const WINDY_HUMIDITY = humidityStops(30, 100);
