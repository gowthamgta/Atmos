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
