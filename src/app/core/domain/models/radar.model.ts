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
  animationFile?: string;
}): RadarStationConfig {
  const band = params.band || 'S-Band';
  const defaultRangeKm = params.rangeKm || (band === 'X-Band' ? 85 : 250);
  const zoom = params.zoom || (band === 'X-Band' ? 9.5 : 8.5);
  const code = params.code.toLowerCase();

  const getRings = (rKm: number) => {
    if (rKm <= 85) return [20, 40, 60, 85];
    if (rKm <= 150) return [50, 100, 150];
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
    lat: 10.9254,
    lng: 79.8380,
    state: 'Puducherry / Tamil Nadu',
    band: 'S-Band',
    rangeKm: 250,
    animationFile: 'animation/Converted/KKL_MAXZ.gif',
    productRanges: {
      caz: 255,
      ppi: 158,
      sri: 158,
      pac: 158,
      ppz: 158
    },
    crops: {
      caz: { x: 0, y: 201, w: 519, h: 519 },
      ppi: { x: 0, y: 0, w: 720, h: 720 },
      sri: { x: 0, y: 0, w: 720, h: 720 },
      pac: { x: 0, y: 0, w: 720, h: 720 },
      ppz: { x: 0, y: 0, w: 720, h: 720 }
    }
  }),
  createImdStation({
    id: 'chennai',
    name: 'Chennai DWR',
    fullName: 'IMD Chennai Port S-Band Doppler Weather Radar (250km)',
    code: 'cni',
    lat: 13.0838,
    lng: 80.2900,
    state: 'Tamil Nadu',
    band: 'S-Band',
    rangeKm: 250,
    animationFile: 'animation/Converted/CNI_MAXZ.gif',
    productRanges: {
      caz: 255,
      ppi: 158,
      sri: 158,
      pac: 158,
      ppz: 158
    },
    crops: {
      caz: { x: 0, y: 201, w: 500, h: 499 },
      ppi: { x: 0, y: 0, w: 800, h: 800 },
      sri: { x: 0, y: 0, w: 600, h: 600 },
      pac: { x: 0, y: 0, w: 599, h: 599 },
      ppz: { x: 0, y: 0, w: 800, h: 800 }
    }
  }),
  createImdStation({
    id: 'pallikaranai',
    name: 'Pallikaranai X-DWR',
    fullName: 'NIOT Pallikaranai High-Resolution X-Band DWR (85km)',
    code: 'plk',
    lat: 12.9451,
    lng: 80.2115,
    state: 'Tamil Nadu',
    band: 'X-Band',
    rangeKm: 85,
    animationFile: 'animation/Converted/CNI_MAXZ.gif',
    productRanges: {
      caz: 87,
      ppi: 87,
      sri: 87,
      pac: 87,
      ppz: 87
    },
    crops: {
      caz: { x: 29, y: 628, w: 1800, h: 1800 },
      ppi: { x: 28, y: 0, w: 2430, h: 2490 },
      sri: { x: 28, y: 0, w: 2430, h: 2485 },
      pac: { x: 28, y: 0, w: 2430, h: 2485 },
      ppz: { x: 28, y: 0, w: 2430, h: 2485 }
    }
  }),
  createImdStation({
    id: 'kochi',
    name: 'Kochi DWR',
    fullName: 'IMD Kochi S-Band Doppler Weather Radar (250km)',
    code: 'koc',
    lat: 9.9312,
    lng: 76.2673,
    state: 'Kerala',
    band: 'S-Band',
    rangeKm: 250,
    animationFile: 'animation/Converted/KOC_MAXZ.gif',
    productRanges: {
      caz: 255,
      ppi: 158,
      sri: 158,
      pac: 158,
      ppz: 158
    },
    crops: {
      caz: { x: 100, y: 300, w: 600, h: 600 },
      ppi: { x: 100, y: 300, w: 600, h: 600 },
      sri: { x: 40, y: 40, w: 708, h: 708 },
      pac: { x: 40, y: 40, w: 708, h: 708 },
      ppz: { x: 100, y: 300, w: 600, h: 600 }
    }
  }),
  createImdStation({
    id: 'thiruvananthapuram',
    name: 'Thiruvananthapuram DWR',
    fullName: 'IMD Thiruvananthapuram C-Band Doppler Weather Radar (240km)',
    code: 'tvm',
    lat: 8.5374,
    lng: 76.8657,
    state: 'Kerala',
    band: 'C-Band',
    rangeKm: 240,
    // Ranges and crops measured from the range rings of each 1082x720 product image
    productRanges: {
      caz: 240,
      ppi: 240,
      sri: 124,
      pac: 76,
      ppz: 240
    },
    crops: {
      caz: { x: 43, y: 181, w: 514, h: 514 },
      ppi: { x: 43, y: 45, w: 652, h: 652 },
      sri: { x: 43, y: 45, w: 652, h: 652 },
      pac: { x: 43, y: 45, w: 652, h: 652 },
      ppz: { x: 43, y: 45, w: 652, h: 652 }
    },
    palettes: {
      caz: paletteFromBins(TVM_COLORS, [56, 52, 48, 44, 40, 36, 32, 28, 24, 20, 16, 12, 8, 4, 0]),
      ppi: paletteFromBins(TVM_COLORS, [60.67, 56.33, 52.0, 47.67, 43.33, 39.0, 34.67, 30.33, 26.0, 21.67, 17.33, 13.0, 8.67, 4.33, 0]),
      sri: paletteFromBins(TVM_COLORS, TVM_RAIN_BINS, rainRateToDbz),
      pac: paletteFromBins(TVM_COLORS, TVM_RAIN_BINS, rainRateToDbz),
      ppz: paletteFromBins(TVM_COLORS, [60.67, 56.33, 52.0, 47.67, 43.33, 39.0, 34.67, 30.33, 26.0, 21.67, 17.33, 13.0, 8.67, 4.33, 0])
    }
  }),
  createImdStation({
    id: 'mangaluru',
    name: 'Mangaluru DWR',
    fullName: 'IMD Mangaluru C-Band Doppler Weather Radar (250km)',
    code: 'mlr',
    // Radar site fitted from the airport markers on the product image (±2 km)
    lat: 12.901,
    lng: 74.856,
    state: 'Karnataka',
    band: 'C-Band',
    rangeKm: 250,
    // Each product's map panel is a square whose half-width is the 250 km range
    crops: {
      caz: { x: 0, y: 200, w: 880, h: 880 },
      ppi: { x: 0, y: 0, w: 822, h: 822 },
      sri: { x: 0, y: 0, w: 800, h: 800 },
      pac: { x: 0, y: 0, w: 1200, h: 1200 },
      ppz: { x: 0, y: 0, w: 880, h: 880 }
    },
    productRanges: {
      caz: 250,
      ppi: 250,
      sri: 250,
      pac: 250,
      ppz: 250
    },
    palettes: {
      caz: MLR_REFLECTIVITY_PALETTE,
      ppi: MLR_REFLECTIVITY_PALETTE,
      sri: MLR_SRI_PALETTE,
      pac: MLR_PAC_PALETTE,
      ppz: MLR_REFLECTIVITY_PALETTE
    }
  })
];

// Station reference constants
export const KARAIKAL_DWR_CONFIG: RadarStationConfig = IMD_RADAR_STATIONS[0];
export const CHENNAI_DWR_CONFIG: RadarStationConfig = IMD_RADAR_STATIONS[1];
export const PALLIKARANAI_DWR_CONFIG: RadarStationConfig = IMD_RADAR_STATIONS[2];
export const KOCHI_DWR_CONFIG: RadarStationConfig = IMD_RADAR_STATIONS[3];
export const THIRUVANANTHAPURAM_DWR_CONFIG: RadarStationConfig = IMD_RADAR_STATIONS[4];
export const MANGALURU_DWR_CONFIG: RadarStationConfig = IMD_RADAR_STATIONS[5];
