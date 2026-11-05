/**
 * Colour scales taken from the legends of windy.com (read from its legend bars for temperature, wind, rain accumulation and
 * the radar): the same colour families, so the map reads like the one people already know. Each list runs from the low end to
 * the high end of its scale and is spread across the layer's own display range (see forecast-layers.ts).
 */

/** Temperature (Windy: purple for the cold end, through blue, green and yellow, to dark red for the heat). */
export const WINDY_TEMP = ['#96d1d8', '#66b3ba', '#5f8fc5', '#508c3d', '#7a921c', '#aba10e', '#dfb106', '#f39606', '#ec5e15', '#be4112', '#8a2a0a'];

/** Wind speed (Windy: blue-grey for calm air, teal and green, then yellow, orange, red and magenta for the strongest). */
export const WINDY_WIND = ['#6271b8', '#3d6ea3', '#4a94aa', '#4a9294', '#4d8e7c', '#4ca44c', '#67a436', '#a2873f', '#a26d5c', '#8d3f5c', '#974b91'];

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
  const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const at = (v: number): string => {
    const i = HUMIDITY_ANCHORS.findIndex(([a]) => a >= v);
    if (i <= 0) return HUMIDITY_ANCHORS[Math.max(i, 0)][1];
    const [v0, c0] = HUMIDITY_ANCHORS[i - 1];
    const [v1, c1] = HUMIDITY_ANCHORS[i];
    const t = (v - v0) / (v1 - v0);
    const [a, b] = [hex(c0), hex(c1)];
    return '#' + a.map((x, k) => Math.round(x + (b[k] - x) * t).toString(16).padStart(2, '0')).join('');
  };
  const stops: string[] = [];
  for (let v = min; v <= max + 1e-9; v += 5) stops.push(at(v));
  return stops;
}

export const WINDY_HUMIDITY = humidityStops(30, 100);
