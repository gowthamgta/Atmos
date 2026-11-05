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

export const WINDY_WIND = windStops(0, 20);

/** Rain (Windy's rain accumulation: slate blue for the lightest, teal and green, then olive, red and magenta for the heaviest). */
export const WINDY_RAIN = ['#3b7ca2', '#3a9aa2', '#32a66e', '#4ba439', '#81a23b', '#a2a23b', '#a23b3b', '#ab366b', '#a43a9a'];

/** Rain accumulation as Windy draws it (3, 10, 25, 100 and 300 mm): violet-blue for the first millimetres, then azure, cyan, green, yellow, orange and red. */
export const WINDY_RAIN_ACCUMULATION = ['#4a3fb8', '#3b52d6', '#2f78e6', '#25a8ea', '#21d2e6', '#3fdc9a', '#7de05a', '#d2e43c', '#f5c820', '#f08a1c', '#d4281f', '#7e0c0c'];

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
  const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const at = (v: number): string => {
    const i = anchors.findIndex(([a]) => a >= v);
    if (i < 0) return anchors[anchors.length - 1][1];
    if (i === 0) return anchors[0][1];
    const [v0, c0] = anchors[i - 1];
    const [v1, c1] = anchors[i];
    const t = (v - v0) / (v1 - v0);
    const [a, b] = [hex(c0), hex(c1)];
    return '#' + a.map((x, k) => Math.round(x + (b[k] - x) * t).toString(16).padStart(2, '0')).join('');
  };
  const stops: string[] = [];
  for (let v = min; v <= max + 1e-9; v += step) stops.push(at(v));
  return stops;
}

export const WINDY_HUMIDITY = humidityStops(30, 100);
