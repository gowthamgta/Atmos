/**
 * Colour scales for weather fields: temperature, wind, rain, rain accumulation, and humidity.
 * Each list runs from the low end to the high end of its scale and is spread across the layer's
 * own display range (see forecast-layers.ts).
 */

/**
 * Temperature in °C, pinned to values using the user-provided 10-step palette:
 * - Emerald green to forest green for freezing & sub-zero (-100 to 0 °C): #106d3f, #24714f
 * - Sea green to muted teal for cool mountain climates (0 to 10 °C): #38755e, #4c796e
 * - Slate teal for pleasant highlands (18 °C): #607d7e
 * - Steel slate for mild coastal / morning (25 °C): #74818d
 * - Muted lavender grey for warm afternoon (30 °C): #88859d
 * - Soft purple for hot afternoon (35 °C): #9c89ad
 * - Medium orchid violet for very hot plains (40 °C): #b08dbc
 * - Light orchid lilac for extreme heatwave (45 to 50 °C): #c491cc
 */
const TEMP_ANCHORS: readonly [number, string][] = [
  [-100, '#106d3f'],
  [-20, '#106d3f'],    // Deep emerald green (extreme cold / upper air)
  [-10, '#24714f'],    // Forest green (-10 °C)
  [0, '#38755e'],      // Sea green / pine (freezing point, 0 °C)
  [10, '#4c796e'],     // Muted teal green (cool mountain tops, 10 °C)
  [18, '#607d7e'],     // Slate teal (highland valleys, 18 °C)
  [25, '#74818d'],     // Steel slate grey (mild, 25 °C)
  [30, '#88859d'],     // Muted lavender grey (warm tropical day, 30 °C)
  [35, '#9c89ad'],     // Soft purple (hot afternoon, 35 °C)
  [40, '#b08dbc'],     // Medium orchid violet (very hot, 40 °C)
  [45, '#c491cc'],     // Light orchid lilac (extreme heatwave, 45 °C)
  [50, '#c491cc'],
];

/** Windy's colour of a temperature (°C), as "#rrggbb". */
export function tempColour(c: number): string {
  return colourAt(TEMP_ANCHORS, c);
}

/** Windy's temperature colours as evenly spaced stops over a display range in °C, so a temperature has the same colour on every layer and level. */
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
 * Rain accumulation in mm: high-contrast meteorological color progression matching the reference standard
 * (5 mm: royal blue, 20 mm: vibrant green, 40 mm: brilliant yellow, 60 mm: orange, 80 mm: fire red,
 * 100 mm: dark maroon, 150 mm: deep violet, 200-300 mm: electric purple/magenta/lavender).
 */
const RAIN_ACCUMULATION_ANCHORS: readonly [number, string][] = [
  [0, '#60b1ff'],
  [2, '#60b1ff'],      // Light sky blue
  [5, '#0661d6'],      // Royal blue (5 mm contour)
  [10, '#0048aa'],     // Deep cobalt blue
  [15, '#0e7c30'],     // Deep green
  [20, '#22c53e'],     // Lush vibrant green (20 mm contour)
  [28, '#44db00'],     // Vivid lime green
  [34, '#f0d810'],     // Golden transition
  [40, '#fff420'],     // Pure bright yellow (40 mm contour)
  [48, '#ffa800'],     // Golden amber
  [54, '#f68e24'],     // Warm orange
  [60, '#f08139'],     // Rich vibrant orange (60 mm contour)
  [68, '#f44818'],     // Coral red-orange
  [74, '#e52028'],     // Crimson red
  [80, '#e01020'],     // Bold fire red (80 mm contour)
  [90, '#b80018'],     // Deep red
  [100, '#8f1009'],    // Dark crimson / maroon (100 mm contour)
  [125, '#6a0408'],    // Deep burgundy
  [150, '#3c0548'],    // Deep violet / dark purple (150 mm contour)
  [180, '#581c87'],    // Intense purple
  [220, '#7e22ce'],    // Vibrant purple
  [260, '#c026d3'],    // Electric magenta / fuchsia
  [300, '#f0abfc'],    // Bright lavender / extreme core
];

/**
 * Rain rate in mm/h in matching meteorological progression
 * (1-2 mm/h: blue, 5 mm/h: green, 10 mm/h: yellow, 20 mm/h: orange, 35 mm/h: red, 50 mm/h: violet).
 */
const RAIN_ANCHORS: readonly [number, string][] = [
  [0, '#60b1ff'],
  [0.5, '#60b1ff'],    // Light sky blue
  [1.2, '#3890f0'],    // Sky blue
  [2.0, '#0661d6'],    // Royal blue (~2 mm/h)
  [3.2, '#0048aa'],    // Deep blue
  [4.0, '#0e7c30'],    // Deep green
  [5.0, '#22c53e'],    // Vibrant green (~5 mm/h)
  [7.0, '#44db00'],    // Vivid lime green
  [8.5, '#f0d810'],    // Golden yellow
  [10.0, '#fff420'],   // Pure bright yellow (~10 mm/h)
  [14.0, '#ffa800'],   // Amber
  [17.0, '#f68e24'],   // Warm orange
  [20.0, '#f08139'],   // Rich vibrant orange (~20 mm/h)
  [26.0, '#f44818'],   // Coral red
  [30.0, '#e52028'],   // Crimson red
  [35.0, '#e01020'],   // Bold fire red (~35 mm/h)
  [42.0, '#8f1009'],   // Dark maroon
  [50.0, '#3c0548'],   // Deep violet / purple (~50 mm/h)
];

/** The palette stops for a value-pinned scale drawn with a gamma (stop i sits at min + (max - min) * (i / n)^(1 / gamma), as the shader reads). */
function gammaStops(anchors: readonly [number, string][], min: number, max: number, gamma: number): string[] {
  const n = 64;
  return Array.from({ length: n + 1 }, (_, i) => colourAt(anchors, min + (max - min) * Math.pow(i / n, 1 / gamma)));
}

export const RAIN_MAX = 50;
export const RAIN_GAMMA = 0.4;
export const RAIN_ACCUMULATION_GAMMA = 0.40;
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
