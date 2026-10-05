/**
 * 500-Meter Tamil Nadu Microclimate Domain Model
 * Covers the whole state: Lat 8.0° N – 13.6° N  |  Lon 76.2° E – 80.4° E
 *
 * The overlay raster is 841 x 1121 cells (~0.55 km each). Columns are uniform in longitude and
 * rows are uniform in Web-Mercator Y, because MapLibre stretches an image source linearly in
 * Mercator space; sampling rows by plain latitude would drift ~1.5 km from the boundary lines.
 */

export interface MicroclimateBounds {
  readonly minLat: number; // 8.0° N  (Kanyakumari)
  readonly maxLat: number; // 13.6° N (Pulicat / Tiruvallur)
  readonly minLon: number; // 76.2° E (Nilgiris / Coimbatore west border)
  readonly maxLon: number; // 80.4° E (Chennai coast)
}

export const REGIONAL_500M_BOUNDS: MicroclimateBounds = {
  minLat: 8.0,
  maxLat: 13.6,
  minLon: 76.2,
  maxLon: 80.4
};

export const REGIONAL_500M_CENTER = {
  lat: 10.8,
  lng: 78.3,
  zoom: 6.6
};

// 0.005° longitude step: 4.2° / 0.005 + 1 = 841 columns (~547 m at 10.8°N)
// 5.6° of latitude spread over 1121 Mercator rows (~555 m each)
export const REGIONAL_GRID_WIDTH = 841;
export const REGIONAL_GRID_HEIGHT = 1121;

// Heatmap render resolution — one pixel per grid cell (~0.5 km).
export const REGIONAL_HEATMAP_WIDTH = REGIONAL_GRID_WIDTH;
export const REGIONAL_HEATMAP_HEIGHT = REGIONAL_GRID_HEIGHT;

/**
 * Native ECMWF IFS 0.25° nodes sampled every 0.5° (so every request lands exactly on a model grid
 * point): 13 rows x 10 columns = 130 nodes covering the raster with a margin.
 */
export const ECMWF_NODE_GRID = {
  minLat: 8.0,
  minLon: 76.0,
  step: 0.5,
  nLat: 13,
  nLon: 10
} as const;

// ── Web-Mercator raster geometry ──────────────────────────────────────────

export function mercatorY(latDeg: number): number {
  return Math.asinh(Math.tan((latDeg * Math.PI) / 180));
}

export function latFromMercatorY(my: number): number {
  return (Math.atan(Math.sinh(my)) * 180) / Math.PI;
}

/** Latitude at the centre of raster row `row` (row 0 is the northern edge). */
export function rasterRowLatitude(
  row: number,
  height: number = REGIONAL_GRID_HEIGHT,
  bounds: MicroclimateBounds = REGIONAL_500M_BOUNDS
): number {
  const myMax = mercatorY(bounds.maxLat);
  const myMin = mercatorY(bounds.minLat);
  return latFromMercatorY(myMax - (row / (height - 1)) * (myMax - myMin));
}

/** Longitude at the centre of raster column `col`. */
export function rasterColumnLongitude(
  col: number,
  width: number = REGIONAL_GRID_WIDTH,
  bounds: MicroclimateBounds = REGIONAL_500M_BOUNDS
): number {
  return bounds.minLon + (col / (width - 1)) * (bounds.maxLon - bounds.minLon);
}

/**
 * Image-source corners [NW, NE, SE, SW]. MapLibre pins the OUTER edges of the image to these
 * coordinates, while REGIONAL_500M_BOUNDS are the centres of the first/last cells, so the corners
 * sit half a cell further out. That makes every pixel land exactly where it was sampled.
 */
export const REGIONAL_500M_COORDINATES: [[number, number], [number, number], [number, number], [number, number]] = (() => {
  const b = REGIONAL_500M_BOUNDS;
  const halfCellLon = (b.maxLon - b.minLon) / (REGIONAL_GRID_WIDTH - 1) / 2;
  const myMax = mercatorY(b.maxLat);
  const myMin = mercatorY(b.minLat);
  const halfCellMercatorY = (myMax - myMin) / (REGIONAL_GRID_HEIGHT - 1) / 2;
  const west = b.minLon - halfCellLon;
  const east = b.maxLon + halfCellLon;
  const north = latFromMercatorY(myMax + halfCellMercatorY);
  const south = latFromMercatorY(myMin - halfCellMercatorY);
  return [
    [west, north], // NW (Top-Left)
    [east, north], // NE (Top-Right)
    [east, south], // SE (Bottom-Right)
    [west, south]  // SW (Bottom-Left)
  ];
})();

// User-requested Palette 1 for Temperature: [#264653, #2a9d8f, #e9c46a, #f4a261, #e76f51]
export const TEMP_PALETTE_HEX = ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'] as const;
export const TEMP_PALETTE_RGB: [number, number, number][] = [
  [38, 70, 83],    // #264653 Deep teal slate
  [42, 157, 143],  // #2a9d8f Persian green / teal
  [233, 196, 106], // #e9c46a Warm saffron yellow
  [244, 162, 97],  // #f4a261 Sandy peach orange
  [231, 111, 81]   // #e76f51 Burnt sienna coral red
];

// User-requested Palette 2 for Humidity: [#f7f7ef, #ddddd4, #9fb9cb, #355c77, #07253a]
export const HUMIDITY_PALETTE_HEX = ['#f7f7ef', '#ddddd4', '#9fb9cb', '#355c77', '#07253a'] as const;
export const HUMIDITY_PALETTE_RGB: [number, number, number][] = [
  [247, 247, 239], // #f7f7ef Dry bone off-white
  [221, 221, 212], // #ddddd4 Light platinum
  [159, 185, 203], // #9fb9cb Slate powder blue
  [53, 92, 119],   // #355c77 Deep ocean blue
  [7, 37, 58]      // #07253a Midnight navy blue
];

// 24-Hour Accumulated Rainfall Palette (Official IMD Warning Scale)
export const RAIN_PALETTE_HEX = ['#f8fafc', '#38bdf8', '#22c55e', '#eab308', '#f97316', '#ef4444', '#a855f7'] as const;
export const RAIN_PALETTE_RGB: [number, number, number][] = [
  [248, 250, 252], // 0 - 2mm Very Light (subtle translucent)
  [56, 189, 248],  // 5mm Light Rain (Sky Cyan)
  [34, 197, 94],   // 15mm Moderate Rain (Emerald Green)
  [234, 179, 8],   // 35mm Rather Heavy (Amber Yellow)
  [249, 115, 22],  // 65mm Heavy Rain (IMD Yellow/Orange Alert)
  [239, 68, 68],   // 115mm Very Heavy Rain (IMD Red Alert)
  [168, 85, 247]   // > 200mm Extremely Heavy Rain (Purple Emergency Warning)
];

// Convective Available Potential Energy (CAPE) Instability Palette
export const CAPE_PALETTE_HEX = ['#64748b', '#06b6d4', '#22c55e', '#eab308', '#f97316', '#ef4444', '#d946ef'] as const;
export const CAPE_PALETTE_RGB: [number, number, number][] = [
  [100, 116, 139], // 0 - 300 J/kg Stable
  [6, 182, 212],   // 600 J/kg Marginal Instability (Cyan)
  [34, 197, 94],   // 1200 J/kg Moderate Instability (Green)
  [234, 179, 8],   // 1800 J/kg High Instability / Thunderstorms (Yellow)
  [249, 115, 22],  // 2600 J/kg Very High Instability / Gale Squalls (Orange)
  [239, 68, 68],   // 3600 J/kg Severe Storm Risk / Hail (Red)
  [217, 70, 239]   // > 4500 J/kg Extreme Convective Explosive Energy (Magenta)
];

// Wind Streamline Palettes: Cold (Cyan Glacier) and Dry (Warm Amber)
export type WindPaletteType = 'cold' | 'dry';

export const WIND_PALETTE_COLD = {
  stroke: 'rgba(56, 189, 248, 0.92)', // Crisp Sky Cyan
  trailFade: 'rgba(0, 0, 0, 0.08)',
  hex: '#38bdf8',
  name: 'Cold (Cyan)'
};

export const WIND_PALETTE_DRY = {
  stroke: 'rgba(245, 158, 11, 0.94)', // Warm Desert Amber
  trailFade: 'rgba(0, 0, 0, 0.08)',
  hex: '#f59e0b',
  name: 'Dry (Amber)'
};

export interface RegionalCityPoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** 1 = major city (always labelled), 2 = district HQ (labelled once zoomed in) */
  tier?: 1 | 2;
}

// The 38 district headquarters of Tamil Nadu
export const TAMIL_NADU_CITIES: RegionalCityPoint[] = [
  { id: 'chennai',         name: 'Chennai',         lat: 13.083, lon: 80.271, tier: 1 },
  { id: 'coimbatore',      name: 'Coimbatore',      lat: 11.017, lon: 76.956, tier: 1 },
  { id: 'madurai',         name: 'Madurai',         lat: 9.925,  lon: 78.120, tier: 1 },
  { id: 'tiruchirappalli', name: 'Tiruchirappalli', lat: 10.790, lon: 78.705, tier: 1 },
  { id: 'salem',           name: 'Salem',           lat: 11.664, lon: 78.146, tier: 1 },
  { id: 'tirunelveli',     name: 'Tirunelveli',     lat: 8.714,  lon: 77.757, tier: 1 },
  { id: 'vellore',         name: 'Vellore',         lat: 12.917, lon: 79.133, tier: 1 },
  { id: 'thanjavur',       name: 'Thanjavur',       lat: 10.787, lon: 79.138, tier: 1 },
  { id: 'ooty',            name: 'Ooty',            lat: 11.410, lon: 76.695, tier: 1 },
  { id: 'kanyakumari',     name: 'Nagercoil',       lat: 8.178,  lon: 77.434, tier: 1 },
  { id: 'erode',           name: 'Erode',           lat: 11.341, lon: 77.717, tier: 2 },
  { id: 'thoothukudi',     name: 'Thoothukudi',     lat: 8.764,  lon: 78.135, tier: 2 },
  { id: 'dindigul',        name: 'Dindigul',        lat: 10.367, lon: 77.980, tier: 2 },
  { id: 'kancheepuram',    name: 'Kancheepuram',    lat: 12.834, lon: 79.704, tier: 2 },
  { id: 'cuddalore',       name: 'Cuddalore',       lat: 11.748, lon: 79.771, tier: 2 },
  { id: 'karur',           name: 'Karur',           lat: 10.960, lon: 78.077, tier: 2 },
  { id: 'namakkal',        name: 'Namakkal',        lat: 11.219, lon: 78.168, tier: 2 },
  { id: 'dharmapuri',      name: 'Dharmapuri',      lat: 12.121, lon: 78.158, tier: 2 },
  { id: 'krishnagiri',     name: 'Krishnagiri',     lat: 12.527, lon: 78.214, tier: 2 },
  { id: 'tiruvannamalai',  name: 'Tiruvannamalai',  lat: 12.225, lon: 79.074, tier: 2 },
  { id: 'viluppuram',      name: 'Viluppuram',      lat: 11.940, lon: 79.486, tier: 2 },
  { id: 'kallakurichi',    name: 'Kallakurichi',    lat: 11.738, lon: 78.960, tier: 2 },
  { id: 'perambalur',      name: 'Perambalur',      lat: 11.234, lon: 78.881, tier: 2 },
  { id: 'ariyalur',        name: 'Ariyalur',        lat: 11.140, lon: 79.079, tier: 2 },
  { id: 'pudukkottai',     name: 'Pudukkottai',     lat: 10.383, lon: 78.800, tier: 2 },
  { id: 'sivaganga',       name: 'Sivaganga',       lat: 9.843,  lon: 78.481, tier: 2 },
  { id: 'ramanathapuram',  name: 'Ramanathapuram',  lat: 9.364,  lon: 78.840, tier: 2 },
  { id: 'virudhunagar',    name: 'Virudhunagar',    lat: 9.585,  lon: 77.962, tier: 2 },
  { id: 'theni',           name: 'Theni',           lat: 10.010, lon: 77.477, tier: 2 },
  { id: 'tenkasi',         name: 'Tenkasi',         lat: 8.959,  lon: 77.315, tier: 2 },
  { id: 'tiruppur',        name: 'Tiruppur',        lat: 11.109, lon: 77.341, tier: 2 },
  { id: 'nagapattinam',    name: 'Nagapattinam',    lat: 10.767, lon: 79.845, tier: 2 },
  { id: 'tiruvarur',       name: 'Tiruvarur',       lat: 10.766, lon: 79.634, tier: 2 },
  { id: 'mayiladuthurai',  name: 'Mayiladuthurai',  lat: 11.102, lon: 79.652, tier: 2 },
  { id: 'tiruvallur',      name: 'Tiruvallur',      lat: 13.123, lon: 79.912, tier: 2 },
  { id: 'chengalpattu',    name: 'Chengalpattu',    lat: 12.682, lon: 79.989, tier: 2 },
  { id: 'ranipet',         name: 'Ranipet',         lat: 12.922, lon: 79.333, tier: 2 },
  { id: 'tirupathur',      name: 'Tirupathur',      lat: 12.495, lon: 78.573, tier: 2 }
];

// Alias kept for existing imports
export const SOUTH_INDIA_CITIES: RegionalCityPoint[] = TAMIL_NADU_CITIES;

export interface RegionalLandmark {
  id: string;
  icon: string;
  name: string;
  lat: number;
  lon: number;
}

// Contrasting spots shown as quick-look chips: high range, coast, and wind gap
export const TAMIL_NADU_LANDMARKS: RegionalLandmark[] = [
  { id: 'doddabetta', icon: '🏔️', name: 'Doddabetta (Nilgiris)', lat: 11.402, lon: 76.735 },
  { id: 'marina', icon: '🌊', name: 'Chennai Coast', lat: 13.050, lon: 80.282 },
  { id: 'palghat-gap', icon: '🌬️', name: 'Palghat Gap (Coimbatore)', lat: 10.870, lon: 76.800 }
];

/** Nearest district HQ to a point, with its approximate distance in km. */
export function nearestCity(lat: number, lon: number): { city: RegionalCityPoint; km: number } {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = TAMIL_NADU_CITIES[0];
  let bestKm = Infinity;
  for (const c of TAMIL_NADU_CITIES) {
    const km = Math.hypot((c.lat - lat) * 111.32, (c.lon - lon) * 111.32 * cosLat);
    if (km < bestKm) {
      bestKm = km;
      best = c;
    }
  }
  return { city: best, km: bestKm };
}

/** Plain-language terrain class for a ground elevation in metres. */
export function describeTerrain(elevationMeters: number): string {
  if (elevationMeters >= 1500) return 'High-range hills';
  if (elevationMeters >= 600) return 'Hill country';
  if (elevationMeters >= 250) return 'Upland plateau';
  if (elevationMeters >= 40) return 'Inland plains';
  return 'Coastal plain';
}

export interface AtmosphericSoundingLevel {
  altitudeMeters: number; // e.g. 0, 500, 1500, 3000, 5500, 9200, 11800, 13000
  pressureHpa: number;    // e.g. 1013, 950, 850, 700, 500, 300, 200, 150
  label: string;          // e.g. 'Ground Level', '850 hPa', '500 hPa', '150 hPa'
  tempC: number;
  humidityPercent: number;
  windSpeedKmh: number;
  windDirectionDeg: number;
}

export interface VerticalInterpolatedState {
  temperatureC: number;
  humidityPercent: number;
  windSpeedKmh: number;
  windDirectionDeg: number;
  levelLabel: string;
}

export interface MicroclimatePointSample {
  lat: number;
  lon: number;
  elevation: number;
  temperature: number;
  humidity: number;
  windSpeed: number;
  windDirection: number;
  zoneName: string;
}

export interface MicroclimateInspectionInfo {
  x: number;
  y: number;
  lat: number;
  lon: number;
  groundElevationMeters: number;
  sliceElevationMeters: number;
  sliceLabel: string;
  temperatureC: number;
  humidityPercent: number;
  windSpeedKmh: number;
  windDirectionDeg: number;
  windDirectionLabel: string;
  rain24hMm: number;
  rainRiskLabel: string;
  capeJkg: number;
  capeRiskLabel: string;
  zone: string;
}

// ── Terrain ───────────────────────────────────────────────────────────────
// Elevation comes from a baked 500 m raster (public/data/tn-elevation-500m.bin.gz) that is loaded
// once at start-up; until it arrives (or if it fails) a flat 100 m surface is assumed.

export const TERRAIN_FALLBACK_METERS = 100;

let terrainRaster: Uint16Array | null = null;

/** Installs the terrain raster (row-major, REGIONAL_GRID_WIDTH x REGIONAL_GRID_HEIGHT, metres). */
export function setTerrainRaster(data: Uint16Array | null): void {
  if (data && data.length !== REGIONAL_GRID_WIDTH * REGIONAL_GRID_HEIGHT) {
    throw new Error(
      `Terrain raster has ${data.length} cells, expected ${REGIONAL_GRID_WIDTH * REGIONAL_GRID_HEIGHT}`
    );
  }
  terrainRaster = data;
}

export function getTerrainRaster(): Uint16Array | null {
  return terrainRaster;
}

/** Ground elevation in metres at any point, bilinearly sampled from the terrain raster. */
export function getRegionalElevation(lat: number, lon: number): number {
  const raster = terrainRaster;
  if (!raster) return TERRAIN_FALLBACK_METERS;

  const b = REGIONAL_500M_BOUNDS;
  const w = REGIONAL_GRID_WIDTH;
  const h = REGIONAL_GRID_HEIGHT;
  const fx = Math.min(w - 1.0001, Math.max(0, ((lon - b.minLon) / (b.maxLon - b.minLon)) * (w - 1)));
  const myMax = mercatorY(b.maxLat);
  const myMin = mercatorY(b.minLat);
  const fy = Math.min(
    h - 1.0001,
    Math.max(0, ((myMax - mercatorY(lat)) / (myMax - myMin)) * (h - 1))
  );
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * w + x0;
  const top = raster[i] * (1 - tx) + raster[i + 1] * tx;
  const bottom = raster[i + w] * (1 - tx) + raster[i + w + 1] * tx;
  return Math.round(top * (1 - ty) + bottom * ty);
}

export function degToCompass(deg: number): string {
  const val = Math.round(deg / 22.5);
  const arr = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return arr[((val % 16) + 16) % 16];
}

/**
 * Blends two compass directions along the shortest arc (e.g. 350° → 10° passes through 0°, not 180°).
 * Returns a direction in [0, 360).
 */
export function blendDirectionDeg(fromDeg: number, toDeg: number, frac: number): number {
  const delta = ((toDeg - fromDeg + 540) % 360) - 180;
  const result = fromDeg + delta * frac;
  return ((result % 360) + 360) % 360;
}

export interface ElevationPreset {
  meters: number;
  label: string;
  tag: string;
}

export const ELEVATION_PRESETS: ElevationPreset[] = [
  { meters: 0, label: 'Ground', tag: 'Surface' },
  { meters: 500, label: '500m', tag: 'Boundary' },
  { meters: 1000, label: '1.0 km', tag: 'Hill Stations' },
  { meters: 1500, label: '1.5 km', tag: '850 hPa Cloud Base' },
  { meters: 3000, label: '3.0 km', tag: '700 hPa Lower Tropo' },
  { meters: 5500, label: '5.5 km', tag: '500 hPa Freezing' },
  { meters: 9000, label: '9.0 km', tag: '300 hPa High Tropo' },
  { meters: 11500, label: '11.5 km', tag: '200 hPa Jet Stream' },
  { meters: 13000, label: '13.0 km', tag: '150 hPa Tropopause' }
];

export function interpolateAtmosphericSounding(
  levels: AtmosphericSoundingLevel[],
  targetAltitudeMeters: number
): VerticalInterpolatedState {
  if (!levels || levels.length === 0) {
    return {
      temperatureC: 30.0,
      humidityPercent: 60.0,
      windSpeedKmh: 10.0,
      windDirectionDeg: 140,
      levelLabel: 'Ground Level'
    };
  }

  const clampedAlt = Math.max(0, Math.min(13000, targetAltitudeMeters));

  if (clampedAlt <= levels[0].altitudeMeters) {
    const l = levels[0];
    return {
      temperatureC: l.tempC,
      humidityPercent: l.humidityPercent,
      windSpeedKmh: l.windSpeedKmh,
      windDirectionDeg: l.windDirectionDeg,
      levelLabel: l.label
    };
  }

  const last = levels[levels.length - 1];
  if (clampedAlt >= last.altitudeMeters) {
    return {
      temperatureC: last.tempC,
      humidityPercent: last.humidityPercent,
      windSpeedKmh: last.windSpeedKmh,
      windDirectionDeg: last.windDirectionDeg,
      levelLabel: last.label
    };
  }

  // Find surrounding levels
  for (let i = 0; i < levels.length - 1; i++) {
    const l1 = levels[i];
    const l2 = levels[i + 1];
    if (clampedAlt >= l1.altitudeMeters && clampedAlt <= l2.altitudeMeters) {
      const span = l2.altitudeMeters - l1.altitudeMeters;
      const frac = span > 0 ? (clampedAlt - l1.altitudeMeters) / span : 0;
      const tempC = l1.tempC + (l2.tempC - l1.tempC) * frac;
      const humidityPercent = Math.max(5, Math.min(100, l1.humidityPercent + (l2.humidityPercent - l1.humidityPercent) * frac));
      const windSpeedKmh = Math.max(0, l1.windSpeedKmh + (l2.windSpeedKmh - l1.windSpeedKmh) * frac);

      // Trigonometric wind direction interpolation
      const rad1 = (l1.windDirectionDeg * Math.PI) / 180;
      const rad2 = (l2.windDirectionDeg * Math.PI) / 180;
      const u1 = -l1.windSpeedKmh * Math.sin(rad1);
      const v1 = -l1.windSpeedKmh * Math.cos(rad1);
      const u2 = -l2.windSpeedKmh * Math.sin(rad2);
      const v2 = -l2.windSpeedKmh * Math.cos(rad2);
      const u = u1 + (u2 - u1) * frac;
      const v = v1 + (v2 - v1) * frac;
      let windDirectionDeg = (Math.atan2(-u, -v) * 180) / Math.PI;
      if (windDirectionDeg < 0) windDirectionDeg += 360;

      let levelLabel = `${(clampedAlt / 1000).toFixed(1)} km`;
      if (clampedAlt === 0) levelLabel = 'Ground Level (Surface)';
      else if (Math.abs(clampedAlt - l2.altitudeMeters) < 60) levelLabel = l2.label;
      else if (Math.abs(clampedAlt - l1.altitudeMeters) < 60) levelLabel = l1.label;

      return {
        temperatureC: Math.round(tempC * 10) / 10,
        humidityPercent: Math.round(humidityPercent),
        windSpeedKmh: Math.round(windSpeedKmh * 10) / 10,
        windDirectionDeg: Math.round(windDirectionDeg),
        levelLabel
      };
    }
  }

  return {
    temperatureC: levels[0].tempC,
    humidityPercent: levels[0].humidityPercent,
    windSpeedKmh: levels[0].windSpeedKmh,
    windDirectionDeg: levels[0].windDirectionDeg,
    levelLabel: levels[0].label
  };
}

export function getRainRiskLabel(mm: number): string {
  if (mm < 2.5) return 'Very Light Rain (<2.5mm)';
  if (mm <= 15.5) return 'Light Rain (2.5-15mm)';
  if (mm <= 64.4) return 'Moderate Rain (15-64mm)';
  if (mm <= 115.5) return '⚠️ Heavy Rain Alert (65-115mm)';
  if (mm <= 204.4) return '🚨 Very Heavy Rain Warning (115-204mm)';
  return '🛑 Disaster Alert: Extremely Heavy Rain (>204mm)';
}

export function getCapeRiskLabel(jkg: number): string {
  if (jkg < 500) return 'Stable Air (Nil Severe Risk)';
  if (jkg <= 1000) return 'Marginal Convective Potential';
  if (jkg <= 2000) return 'Moderate Thunderstorm Risk';
  if (jkg <= 3000) return '⚡ High Severe Storm Risk (Lightning/Squalls)';
  if (jkg <= 4500) return '⛈️ Violent Convective Storms / Hail';
  return '🌪️ Extreme Explosive Instability (>4500 J/kg)';
}
