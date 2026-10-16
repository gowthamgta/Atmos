export type RadarProductKey = 'caz' | 'ppi' | 'sri' | 'pac' | 'ppz';
export type RadarBand = 'S-Band' | 'C-Band' | 'X-Band';

export interface RadarCropConfig {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One legend swatch of an IMD radar image, converted to an equivalent reflectivity (dBZ). */
export interface RadarPaletteEntry {
  rgb: [number, number, number];
  dbz: number;
  /** How far each colour channel may be from `rgb` and still count as this swatch (6 when absent). */
  tol?: number;
  /**
   * A colour the basemap also uses (white, cream, light blue, the sea): it counts as an echo only where echoes of the other colours
   * are next to it, so the strong core of a cell is kept and a white label or a stretch of sea is not.
   */
  context?: boolean;
}

export interface RadarProductConfig {
  name: string;
  title: string;
  icon: string;
  file: string;
  url: string;
  rangeKm: number;
  rings: number[];
  bounds: [[number, number], [number, number]]; // [[south, west], [north, east]]
  maplibreCoordinates: [[number, number], [number, number], [number, number], [number, number]]; // [NW, NE, SE, SW]
  crop?: RadarCropConfig;
  /** Where the picture prints its scan time ("HH:MM:SS UTC / date"), for pictures that carry no timestamp in the GIF itself. */
  stampBox?: RadarCropConfig;
  /**
   * Exact legend colours of this product's image. When set, pixels are classified by matching
   * these colours instead of the generic colour heuristics (needed where the basemap uses
   * colours that resemble echoes, e.g. Mangaluru's cyan sea).
   */
  palette?: RadarPaletteEntry[];
}

export interface RadarStationConfig {
  id: string;
  name: string;
  fullName: string;
  code: string; // 3-letter IMD radar file suffix
  badgeText: string;
  lat: number;
  lng: number;
  zoom: number;
  state: string;
  agency: string;
  band: RadarBand;
  frequency: string;
  operationalRangeKm: number;
  rings: number[];
  animationFile?: string; // 3-Hour Animation GIF path (e.g. animation/Converted/KKL_MAXZ.gif)
  /** True when its animation is too big to download for the one-hour loop (the live picture is still used in it). */
  skipAnimation?: boolean;
  products: Record<RadarProductKey, RadarProductConfig>;
}

export interface RadarObservationTiming {
  ist: string;
  utc: string;
  date: string;
  raw?: string;
  epochMs?: number;
  source?: string;
  ageMinutes?: number;
  freshness?: 'fresh' | 'recent' | 'stale' | 'offline';
}

export interface RadarHoverInfo {
  x: number;
  y: number;
  lat: number;
  lng: number;
  dbz: number;
  label: string;
  color: string;
  rate: string;
}

export interface RadarFieldData {
  field: Float32Array;
  cropW: number;
  cropH: number;
  cx: number;
  cy: number;
  radius: number;
  bounds: [[number, number], [number, number]];
}

export interface ProcessedRadarResult {
  stationId?: string;
  dataUrl: string;
  /** The mosaic's intensity as one byte per pixel (see quantizeRadarField), for the GPU layer. */
  displayField?: Uint8Array;
  fieldData: RadarFieldData;
  timing: RadarObservationTiming | null;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  isDisplayed?: boolean;
}

/**
 * Calculates accurate geographic bounding box and MapLibre corner coordinates
 * for an IMD radar station given its latitude, longitude, and operational radius in kilometers.
 */
export function computeRadarBounds(
  lat: number,
  lng: number,
  rangeKm: number
): {
  bounds: [[number, number], [number, number]];
  maplibreCoordinates: [[number, number], [number, number], [number, number], [number, number]];
} {
  const dLat = rangeKm / 111.32;
  const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  const dLng = rangeKm / (111.32 * cosLat);

  const south = lat - dLat;
  const north = lat + dLat;
  const west = lng - dLng;
  const east = lng + dLng;

  return {
    bounds: [[south, west], [north, east]],
    maplibreCoordinates: [
      [west, north], // NW
      [east, north], // NE
      [east, south], // SE
      [west, south]  // SW
    ]
  };
}

/** Marshall-Palmer Z-R relation (Z = 200·R^1.6): converts a rain rate in mm/h to dBZ. */
export function rainRateToDbz(mmPerHour: number): number {
  return 10 * Math.log10(200 * Math.pow(Math.max(0.01, mmPerHour), 1.6));
}

/**
 * Builds a legend palette from swatch colours (strongest first) and the lower bound of each
 * swatch's bin. Each swatch is assigned the midpoint of its bin, converted to dBZ.
 */
function paletteFromBins(
  colors: [number, number, number][],
  lowerBounds: number[],
  toDbz: (value: number) => number = v => v
): RadarPaletteEntry[] {
  return colors.map((rgb, i) => {
    const lower = lowerBounds[i];
    const upper = i > 0 ? lowerBounds[i - 1] : lower + (lower - lowerBounds[1]);
    return { rgb, dbz: Math.round(toDbz((lower + upper) / 2) * 10) / 10 };
  });
}

// Thiruvananthapuram (C-Band) legend: identical colours across CAZ / PPI / SRI / PAC.
const TVM_COLORS: [number, number, number][] = [
  [199, 0, 78], [199, 0, 0], [254, 62, 0], [254, 114, 0], [254, 188, 0], [254, 229, 0],
  [254, 247, 192], [254, 254, 254], [134, 240, 254], [82, 208, 254], [25, 162, 254],
  [0, 120, 254], [0, 51, 254], [0, 0, 199], [57, 0, 159]
];
const TVM_RAIN_BINS = [93.34, 86.68, 80.02, 73.36, 66.70, 60.04, 53.38, 46.72, 40.06, 33.40, 26.74, 20.08, 13.42, 6.76, 0.10];

// Mangaluru (C-Band) legends. White (41 dBZ / 50 mm/h) is omitted because the basemap draws
// district borders and the coastline in pure white; red (>100 mm/h SRI) is omitted because town
// markers are pure red. Neighbouring swatches still cover those cores after smoothing.
const MLR_REFLECTIVITY_PALETTE = paletteFromBins(
  [[163, 0, 0], [199, 0, 0], [225, 63, 0], [255, 63, 0], [255, 188, 0], [255, 229, 0], [255, 247, 192],
   [134, 240, 255], [83, 208, 255], [26, 162, 255], [0, 121, 255], [0, 52, 255], [0, 0, 199], [0, 0, 160], [0, 0, 147]],
  [60.0, 57.3, 54.7, 52.0, 49.3, 46.7, 44.0, 38.7, 36.0, 33.3, 30.7, 28.0, 25.3, 22.7, 20.0]
);
const MLR_RAIN_BINS = [92.9, 85.9, 78.8, 71.7, 64.6, 57.6, 43.4, 36.4, 29.3, 22.2, 15.1, 8.1, 1.0];
const MLR_SRI_PALETTE = paletteFromBins(
  [[255, 55, 0], [255, 111, 0], [255, 170, 0], [255, 191, 64], [255, 213, 128], [250, 233, 196],
   [169, 255, 255], [85, 255, 255], [0, 255, 255], [0, 167, 223], [0, 96, 191], [0, 40, 159], [0, 0, 127]],
  MLR_RAIN_BINS,
  rainRateToDbz
);
const MLR_PAC_PALETTE = paletteFromBins(
  [[213, 46, 0], [234, 101, 0], [255, 170, 0], [255, 191, 64], [255, 213, 128], [251, 233, 195],
   [170, 255, 255], [85, 255, 255], [0, 255, 255], [0, 167, 223], [0, 96, 191], [0, 40, 159], [0, 0, 127]],
  MLR_RAIN_BINS,
  rainRateToDbz
);

// Chennai (S-Band) MAX(Z) picture: 16 swatches, 20 to 60 dBZ in steps of 2.5 (read off the picture's colour bar; the middle of each step is
// the dBZ; strongest first, and a swatch the GIF draws in two nearby colours has both). The picture's sea is light blue and its labels white, so those swatches count only next to other echoes. The picture's
// GIF repeats one colour for two steps in places (yellow-orange for 42.5 to 47.5), so that colour takes the middle, 45.
const CNI_CAZ_PALETTE: RadarPaletteEntry[] = [
  { rgb: [153, 0, 51], dbz: 61 }, { rgb: [102, 0, 51], dbz: 61 }, { rgb: [153, 0, 0], dbz: 58 }, { rgb: [204, 0, 0], dbz: 53.75 },
  { rgb: [255, 51, 0], dbz: 51.25 }, { rgb: [255, 102, 0], dbz: 48.75 }, { rgb: [255, 204, 0], dbz: 45 }, { rgb: [255, 255, 0], dbz: 43.75 },
  { rgb: [255, 255, 204], dbz: 41.25, context: true }, { rgb: [255, 255, 255], dbz: 38.75, context: true },
  { rgb: [153, 255, 255], dbz: 36.25, context: true }, { rgb: [102, 255, 255], dbz: 36.25, context: true }, { rgb: [102, 204, 255], dbz: 33.75, context: true },
  { rgb: [51, 153, 255], dbz: 31.25 }, { rgb: [0, 153, 255], dbz: 31.25 }, { rgb: [0, 102, 255], dbz: 28.75 }, { rgb: [0, 51, 255], dbz: 26.25 },
  { rgb: [0, 0, 204], dbz: 23.75 }, { rgb: [0, 0, 153], dbz: 21.25 },
];

// Karaikal (S-Band) MAX(Z) picture: its colour scale is a smooth gradient from 20 dBZ (indigo) through blue, cyan, white, yellow and
// orange to red at 60 (sampled down the picture's colour bar every 3 pixels). Echoes take any shade along it, so a pixel is matched to the
// nearest sample. The pale and yellow end resembles the relief map, so from 36 dBZ up a pixel counts only next to other echoes.
const KKL_RAMP: [number, number, number, number][] = [
  [200, 0, 37, 60.2], [200, 0, 22, 59.7], [200, 0, 10, 59.1], [203, 4, 2, 58.6], [210, 11, 6, 58.1], [219, 21, 12, 57.6], [234, 39, 22, 57.1],
  [241, 47, 27, 56.5], [255, 63, 34, 56.0], [255, 62, 27, 55.0], [255, 60, 14, 54.5], [255, 59, 8, 54.0], [255, 59, 4, 53.4], [255, 58, 0, 52.9],
  [255, 59, 0, 52.4], [255, 60, 0, 51.9], [255, 61, 0, 51.4], [255, 62, 0, 50.9], [255, 78, 0, 49.8], [255, 86, 0, 49.3], [255, 103, 0, 48.8],
  [255, 110, 0, 48.3], [255, 127, 0, 47.8], [255, 138, 0, 47.2], [255, 146, 0, 46.7], [255, 159, 0, 46.2], [255, 169, 0, 45.7], [255, 183, 0, 45.2],
  [255, 193, 0, 44.7], [255, 197, 0, 44.1], [255, 206, 0, 43.6], [255, 214, 0, 43.1], [255, 222, 0, 42.6], [255, 229, 0, 42.1], [255, 237, 72, 41.5],
  [255, 238, 88, 41.0], [255, 243, 135, 40.5], [255, 250, 207, 40.0], [255, 253, 231, 39.5], [234, 249, 255, 39.0], [207, 242, 255, 38.4],
  [164, 230, 255, 37.9], [132, 222, 255, 37.4], [110, 216, 255, 36.9], [78, 205, 255, 36.4], [73, 201, 255, 35.9], [53, 185, 255, 35.3],
  [46, 179, 255, 34.8], [35, 170, 255, 34.3], [26, 162, 255, 33.8], [22, 157, 255, 33.3], [18, 149, 255, 32.8], [12, 140, 255, 32.2],
  [7, 132, 255, 31.7], [2, 125, 255, 31.2], [0, 115, 255, 30.7], [0, 102, 255, 30.2], [0, 92, 255, 29.7], [0, 72, 255, 29.1], [0, 64, 255, 28.6],
  [0, 51, 254, 28.1], [0, 37, 240, 27.6], [0, 32, 233, 27.1], [0, 22, 223, 26.6], [0, 11, 212, 26.0], [0, 2, 203, 25.5], [11, 0, 193, 25.0],
  [16, 0, 189, 24.5], [31, 0, 179, 24.0], [42, 0, 171, 23.4], [53, 0, 164, 22.9], [58, 0, 160, 22.4],
];
const KKL_CAZ_PALETTE: RadarPaletteEntry[] = KKL_RAMP.map(([r, g, b, dbz]) => ({ rgb: [r, g, b], dbz, tol: 12, context: dbz >= 36 }));

// Karaikal PPI (150 km, 0.5 degrees, 2 to 72 dBZ) uses the same colours stretched over a wider, uneven scale (16 equal boxes labelled
// 2 7 12 18 21 23 28 34 37 39 44 50 53 55 60 66 72): sampled down the colour bar every 3 pixels, dBZ interpolated between the labels.
// Its light rain (7 to 28 dBZ) is most of what the picture shows, and the CAZ (20 dBZ and up) leaves it out.
const KKL_PPI_RAMP: [number, number, number, number][] = [
  [200, 0, 79, 72.0], [200, 0, 58, 64.8], [200, 0, 42, 63.6], [200, 0, 33, 62.4], [200, 0, 11, 61.2], [200, 1, 5, 60.0], [212, 14, 8, 59.0], [223, 27, 15, 58.0], [234, 39, 22, 57.0], [247, 54, 31, 56.0], [255, 63, 35, 55.0], [255, 62, 28, 54.6], [255, 61, 20, 54.2], [255, 60, 12, 53.8], [255, 59, 9, 53.4], [255, 58, 0, 53.0], [255, 59, 0, 52.4], [255, 60, 0, 51.8], [255, 61, 0, 51.2], [255, 62, 0, 50.6], [255, 63, 0, 50.0], [255, 76, 0, 48.8], [255, 90, 0, 47.6], [255, 103, 0, 46.4], [255, 118, 0, 45.2], [255, 129, 0, 44.0], [255, 141, 0, 43.0], [255, 153, 0, 42.0], [255, 165, 0, 41.0], [255, 177, 0, 40.0], [255, 189, 0, 39.0], [255, 197, 0, 38.6], [255, 206, 0, 38.2], [255, 214, 0, 37.8], [255, 220, 0, 37.4], [255, 226, 0, 37.0], [254, 236, 67, 36.4], [255, 240, 104, 35.8], [255, 245, 151, 35.2], [255, 250, 199, 34.6], [255, 255, 254, 34.0], [221, 246, 255, 32.8], [185, 236, 255, 31.6], [153, 228, 255, 30.4], [121, 219, 255, 29.2], [84, 209, 255, 28.0], [74, 202, 255, 27.0], [63, 193, 255, 26.0], [49, 182, 255, 25.0], [38, 173, 255, 24.0], [27, 164, 255, 23.0], [20, 154, 255, 22.6], [15, 146, 255, 22.2], [10, 137, 255, 21.8], [5, 128, 255, 21.4], [0, 120, 255, 21.0], [0, 110, 255, 20.4], [0, 93, 255, 19.8], [0, 80, 255, 19.2], [0, 67, 255, 18.6], [0, 53, 255, 18.0], [0, 43, 245, 16.8], [0, 31, 233, 15.6], [0, 20, 221, 14.4], [0, 12, 212, 13.2], [0, 1, 201, 12.0], [9, 0, 194, 11.0], [20, 0, 186, 10.0], [31, 0, 179, 9.0], [45, 0, 169, 8.0], [56, 0, 161, 7.0], [58, 0, 160, 6.0],
];
const KKL_PPI_PALETTE: RadarPaletteEntry[] = KKL_PPI_RAMP.map(([r, g, b, dbz]) => ({ rgb: [r, g, b], dbz, tol: 12, context: dbz >= 34 }));

/**
 * Factory helper to construct complete RadarStationConfig with all IMD products.
 */
function createImdStation(params: {
  id: string;
  name: string;
  fullName?: string;
  code: string;
  lat: number;
  lng: number;
  state: string;
  band?: RadarBand;
  rangeKm?: number;
  zoom?: number;
  crops?: Partial<Record<RadarProductKey, RadarCropConfig>>;
  productRanges?: Partial<Record<RadarProductKey, number>>;
  palettes?: Partial<Record<RadarProductKey, RadarPaletteEntry[]>>;
  /** Box around the printed scan time of each product's picture (see RadarProductConfig.stampBox). */
  stamps?: Partial<Record<RadarProductKey, RadarCropConfig>>;
  animationFile?: string;
  skipAnimation?: boolean;
}): RadarStationConfig {
  const band = params.band || 'S-Band';
  const defaultRangeKm = params.rangeKm || (band === 'X-Band' ? 85 : 250);
  const zoom = params.zoom || (band === 'X-Band' ? 9.5 : 8.5);
  const code = params.code.toLowerCase();

  const getRings = (rKm: number) => {
    if (rKm <= 85) return [20, 40, 60, 85];
    if (rKm <= 160) return [50, 100, 150];
    return [50, 100, 150, 200, 250];
  };

  const createProdConfig = (
    key: RadarProductKey,
    name: string,
    title: string,
    icon: string,
    defaultR: number
  ): RadarProductConfig => {
    const rangeKm = params.productRanges?.[key] ?? (key === 'ppz' ? params.productRanges?.ppi : undefined) ?? defaultR;
    const rings = getRings(rangeKm);
    const { bounds, maplibreCoordinates } = computeRadarBounds(params.lat, params.lng, rangeKm);
    return {
      name,
      title,
      icon,
      file: `${key}_${code}.gif`,
      url: `https://mausam.imd.gov.in/Radar/${key}_${code}.gif`,
      rangeKm,
      rings,
      bounds,
      maplibreCoordinates,
      crop: params.crops?.[key] ?? (key === 'ppz' ? params.crops?.ppi : undefined),
      stampBox: params.stamps?.[key],
      palette: params.palettes?.[key] ?? (key === 'ppz' ? params.palettes?.ppi : undefined)
    };
  };

  return {
    id: params.id,
    name: params.name,
    fullName: params.fullName || `IMD ${params.name} ${band} Doppler Weather Radar`,
    code,
    badgeText: `IMD ${params.name} (${band})`,
    lat: params.lat,
    lng: params.lng,
    zoom,
    state: params.state,
    agency: 'India Meteorological Department (IMD)',
    band,
    frequency: band === 'X-Band' ? '9.3 GHz (X-Band)' : band === 'C-Band' ? '5.6 GHz (C-Band)' : '2.8 GHz (S-Band)',
    operationalRangeKm: defaultRangeKm,
    rings: getRings(defaultRangeKm),
    animationFile: params.animationFile,
    skipAnimation: params.skipAnimation,
    products: {
      caz: createProdConfig('caz', 'CAZ', 'Column Maximum Reflectivity (MAX_Z)', '🌩️', defaultRangeKm),
      ppi: createProdConfig('ppi', 'PPI', 'Plan Position Indicator (Base Sweep)', '⚡', band === 'X-Band' ? 85 : 150),
      sri: createProdConfig('sri', 'SRI', 'Surface Rainfall Intensity (mm/h)', '🌧️', band === 'X-Band' ? 85 : 150),
      pac: createProdConfig('pac', 'PAC', 'Precipitation Accumulation (Rain Total)', '💧', band === 'X-Band' ? 85 : 150),
      ppz: createProdConfig('ppz', 'PPZ', 'Plan Position Indicator (Reflectivity Z)', '🎯', band === 'X-Band' ? 85 : 150)
    }
  };
}

// 📡 Official IMD Doppler Weather Radar Network (Karaikal, Chennai, Pallikaranai, Kochi, Thiruvananthapuram, Mangaluru)
export const IMD_RADAR_STATIONS: RadarStationConfig[] = [
  createImdStation({
    id: 'karaikal',
    name: 'Karaikal DWR',
    fullName: 'IMD Karaikal S-Band Doppler Weather Radar (250km)',
    code: 'kkl',
    lat: 10.9129,
    lng: 79.8418,
    state: 'Puducherry / Tamil Nadu',
    band: 'S-Band',
    rangeKm: 250,
    animationFile: 'animation/Converted/KKL_MAXZ.gif',
    productRanges: {
      caz: 255,
      ppi: 150,
      sri: 158,
      pac: 158,
      ppz: 500
    },
    crops: {
      caz: { x: 0, y: 201, w: 519, h: 519 },
      ppi: { x: 0, y: 0, w: 720, h: 720 },
      sri: { x: 0, y: 0, w: 720, h: 720 },
      pac: { x: 0, y: 0, w: 720, h: 720 },
      ppz: { x: 0, y: 0, w: 720, h: 720 }
    },
    // the PPZ (500 km) legend is the same 20 to 60 dBZ gradient as the CAZ
    palettes: { caz: KKL_CAZ_PALETTE, ppz: KKL_CAZ_PALETTE, ppi: KKL_PPI_PALETTE }
  }),
  createImdStation({
    id: 'chennai',
    name: 'Chennai DWR',
    fullName: 'IMD Chennai Port S-Band Doppler Weather Radar (250km)',
    code: 'cni',
    lat: 13.0839,
    lng: 80.2901,
    state: 'Tamil Nadu',
    band: 'S-Band',
    rangeKm: 250,
    animationFile: 'animation/Converted/CNI_MAXZ.gif',
    productRanges: {
      caz: 255,
      ppi: 150,
      sri: 158,
      pac: 158,
      ppz: 600
    },
    crops: {
      caz: { x: 0, y: 201, w: 500, h: 499 },
      ppi: { x: 0, y: 0, w: 800, h: 800 },
      sri: { x: 0, y: 0, w: 600, h: 600 },
      pac: { x: 0, y: 0, w: 599, h: 599 },
      ppz: { x: 0, y: 0, w: 800, h: 800 }
    },
    palettes: { caz: CNI_CAZ_PALETTE }
  }),
];

// Station reference constants
export const KARAIKAL_DWR_CONFIG: RadarStationConfig = IMD_RADAR_STATIONS[0];
