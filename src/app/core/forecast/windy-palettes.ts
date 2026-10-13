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

/** Relative humidity (Windy: brown for the dry end, through olive and green, to teal and blue-slate for the moistest air). */
export const WINDY_HUMIDITY = ['#ae6e38', '#ae9338', '#69ae38', '#36af94', '#389dae', '#3884ae', '#386fa6', '#384672'];
