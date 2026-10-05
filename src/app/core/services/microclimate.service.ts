import { Injectable, signal, computed, inject, effect, OnDestroy, WritableSignal } from '@angular/core';
import { MapLayerService } from './map-layer.service';
import {
  REGIONAL_500M_BOUNDS,
  REGIONAL_500M_CENTER,
  REGIONAL_500M_COORDINATES,
  REGIONAL_GRID_WIDTH,
  REGIONAL_GRID_HEIGHT,
  REGIONAL_HEATMAP_WIDTH,
  REGIONAL_HEATMAP_HEIGHT,
  ECMWF_NODE_GRID,
  TAMIL_NADU_CITIES,
  TAMIL_NADU_LANDMARKS,
  getRegionalElevation,
  getTerrainRaster,
  setTerrainRaster,
  nearestCity,
  describeTerrain,
  degToCompass,
  blendDirectionDeg,
  MicroclimateInspectionInfo,
  TEMP_PALETTE_RGB,
  TEMP_PALETTE_HEX,
  HUMIDITY_PALETTE_RGB,
  HUMIDITY_PALETTE_HEX,
  RAIN_PALETTE_RGB,
  RAIN_PALETTE_HEX,
  CAPE_PALETTE_RGB,
  CAPE_PALETTE_HEX,
  getRainRiskLabel,
  getCapeRiskLabel,
  WindPaletteType,
  WIND_PALETTE_COLD,
  WIND_PALETTE_DRY,
  AtmosphericSoundingLevel,
  interpolateAtmosphericSounding,
  ELEVATION_PRESETS
} from '../domain/models/microclimate.model';
import {
  LAPSE_RATE_C_PER_M,
  buildMicroclimateBaseGrids,
  downscaleCape,
  downscaleHumidity,
  downscaleRain,
  downscaleTemperature,
  orographicFraction,
  windSpeedup,
  MicroclimateBaseGrids,
  MicroclimateGridInput
} from '../domain/math/microclimate-grid';

type RasterMode = 'temp' | 'humidity' | 'rain-24h' | 'cape';
type Rgb = [number, number, number];
type ColorStops = readonly (readonly [number, Rgb])[];
export type NwpStatus = 'estimate' | 'cached' | 'live';

// Maps an active layer id to the single 500 m raster it needs (wind is drawn separately).
const LAYER_TO_RASTER_MODE: Record<string, RasterMode> = {
  'temp-500m': 'temp',
  'humidity-500m': 'humidity',
  'rain-24h': 'rain-24h',
  cape: 'cape'
};

const TERRAIN_URL = '/data/tn-elevation-500m.bin.gz';
const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';

// The statewide request costs ~130 Open-Meteo calls. ECMWF IFS only changes hourly, so refreshing
// every 30 min keeps a single browser at ~6,300 calls/day, inside the free 10,000/day allowance.
const NWP_REFRESH_MS = 30 * 60 * 1000;
const NWP_CACHE_KEY = 'atmos_tn_nwp_v1';
const NWP_FETCH_TIMEOUT_MS = 25000;

// ── Colour ramps ──────────────────────────────────────────────────────────

// Temperature palette is calibrated to fixed physical thresholds so altitude cooling shows on the map
const TEMP_STOPS: ColorStops = [
  [18.0, TEMP_PALETTE_RGB[0]],
  [22.0, TEMP_PALETTE_RGB[1]],
  [26.0, TEMP_PALETTE_RGB[2]],
  [30.0, TEMP_PALETTE_RGB[3]],
  [34.0, TEMP_PALETTE_RGB[4]]
];
const HUMIDITY_STOPS: ColorStops = [
  [20.0, HUMIDITY_PALETTE_RGB[0]],
  [40.0, HUMIDITY_PALETTE_RGB[1]],
  [60.0, HUMIDITY_PALETTE_RGB[2]],
  [80.0, HUMIDITY_PALETTE_RGB[3]],
  [100.0, HUMIDITY_PALETTE_RGB[4]]
];
const RAIN_STOPS: ColorStops = [
  [0.0, RAIN_PALETTE_RGB[0]],
  [5.0, RAIN_PALETTE_RGB[1]],
  [15.0, RAIN_PALETTE_RGB[2]],
  [35.0, RAIN_PALETTE_RGB[3]],
  [65.0, RAIN_PALETTE_RGB[4]],
  [115.0, RAIN_PALETTE_RGB[5]],
  [204.0, RAIN_PALETTE_RGB[6]]
];
const CAPE_STOPS: ColorStops = [
  [0.0, CAPE_PALETTE_RGB[0]],
  [500.0, CAPE_PALETTE_RGB[1]],
  [1000.0, CAPE_PALETTE_RGB[2]],
  [1800.0, CAPE_PALETTE_RGB[3]],
  [2600.0, CAPE_PALETTE_RGB[4]],
  [3600.0, CAPE_PALETTE_RGB[5]],
  [4500.0, CAPE_PALETTE_RGB[6]]
];

function sampleStops(stops: ColorStops, v: number): Rgb {
  if (v <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (v >= last[0]) return last[1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [v0, c0] = stops[i];
    const [v1, c1] = stops[i + 1];
    if (v >= v0 && v <= v1) {
      const t = (v - v0) / (v1 - v0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * t),
        Math.round(c0[1] + (c1[1] - c0[1]) * t),
        Math.round(c0[2] + (c1[2] - c0[2]) * t)
      ];
    }
  }
  return last[1];
}

/** Packs RGBA for a little-endian Uint32 view over ImageData. */
function packRgba(rgb: Rgb, alpha: number): number {
  return ((alpha << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]) >>> 0;
}

function buildLut(size: number, valueAt: (i: number) => number, stops: ColorStops, alphaAt: (v: number) => number): Uint32Array {
  const lut = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    const v = valueAt(i);
    lut[i] = packRgba(sampleStops(stops, v), alphaAt(v));
  }
  return lut;
}

// Per-pixel lookup tables: a 943k-cell heatmap needs no per-pixel allocation or interpolation.
const TEMP_LUT_MIN = 18.0;
const TEMP_LUT_STEP = 0.1;
let tempLut: Uint32Array | null = null;
let humidityLut: Uint32Array | null = null;
let rainLut: Uint32Array | null = null;
let capeLut: Uint32Array | null = null;

function getTempLut(): Uint32Array {
  return tempLut ??= buildLut(161, i => TEMP_LUT_MIN + i * TEMP_LUT_STEP, TEMP_STOPS, () => 230);
}
function getHumidityLut(): Uint32Array {
  return humidityLut ??= buildLut(101, i => i, HUMIDITY_STOPS, () => 230);
}
function getRainLut(): Uint32Array {
  return rainLut ??= buildLut(2041, i => i / 10, RAIN_STOPS,
    mm => mm < 0.2 ? 35 : Math.min(235, 140 + Math.round(mm * 1.5)));
}
function getCapeLut(): Uint32Array {
  return capeLut ??= buildLut(4501, i => i, CAPE_STOPS, () => 220);
}

// ── Cached model snapshot ─────────────────────────────────────────────────

interface NwpSnapshot {
  ts: number;
  temps: number[];
  hums: number[];
  windSpeeds: number[];
  windDirs: number[];
  rain24h: number[];
  cape: number[];
  elev: number[];
  sounding: AtmosphericSoundingLevel[] | null;
  base: { temp: number; hum: number; windSpeed: number; windDeg: number } | null;
}

@Injectable({ providedIn: 'root' })
export class MicroclimateService implements OnDestroy {
  private ls = inject(MapLayerService);

  readonly bounds = REGIONAL_500M_BOUNDS;
  readonly center = REGIONAL_500M_CENTER;
  readonly coordinates = REGIONAL_500M_COORDINATES;
  readonly gridWidth = REGIONAL_GRID_WIDTH;
  readonly gridHeight = REGIONAL_GRID_HEIGHT;

  // Selected vertical elevation slice (0m to 13,000m)
  readonly selectedElevationMeters = signal<number>(0);
  readonly elevationPresets = ELEVATION_PRESETS;

  // Display mode for microclimate: pure temperature, pure humidity, pure wind, rain-24h, or cape
  readonly rasterMode = signal<'temp' | 'humidity' | 'wind' | 'rain-24h' | 'cape'>('temp');

  // Wind Streamline Palette: 'cold' (cyan glacier) or 'dry' (desert amber)
  readonly windPaletteMode = signal<WindPaletteType>('cold');
  readonly windPaletteCold = WIND_PALETTE_COLD;
  readonly windPaletteDry = WIND_PALETTE_DRY;

  // Atmospheric Sounding Profile (Ground to 13km / 150 hPa)
  readonly soundingLevels = signal<AtmosphericSoundingLevel[]>([
    { altitudeMeters: 0, pressureHpa: 1013, label: 'Ground Level (Surface)', tempC: 31.5, humidityPercent: 58, windSpeedKmh: 6.5, windDirectionDeg: 140 },
    { altitudeMeters: 500, pressureHpa: 950, label: '500m Boundary Layer', tempC: 28.2, humidityPercent: 66, windSpeedKmh: 12.0, windDirectionDeg: 130 },
    { altitudeMeters: 1500, pressureHpa: 850, label: '1.5 km (850 hPa Cloud Base)', tempC: 21.7, humidityPercent: 75, windSpeedKmh: 18.5, windDirectionDeg: 95 },
    { altitudeMeters: 3000, pressureHpa: 700, label: '3.0 km (700 hPa Lower Tropo)', tempC: 12.0, humidityPercent: 62, windSpeedKmh: 19.0, windDirectionDeg: 90 },
    { altitudeMeters: 5500, pressureHpa: 500, label: '5.5 km (500 hPa Freezing)', tempC: -4.0, humidityPercent: 42, windSpeedKmh: 22.0, windDirectionDeg: 85 },
    { altitudeMeters: 9200, pressureHpa: 300, label: '9.2 km (300 hPa Upper Tropo)', tempC: -31.0, humidityPercent: 32, windSpeedKmh: 35.0, windDirectionDeg: 75 },
    { altitudeMeters: 11800, pressureHpa: 200, label: '11.8 km (200 hPa Jet Level)', tempC: -52.0, humidityPercent: 28, windSpeedKmh: 45.0, windDirectionDeg: 70 },
    { altitudeMeters: 13000, pressureHpa: 150, label: '13.0 km (150 hPa Tropopause)', tempC: -64.0, humidityPercent: 25, windSpeedKmh: 38.0, windDirectionDeg: 65 }
  ]);

  // Interpolated sounding state at selected elevation
  readonly currentSoundingState = computed(() =>
    interpolateAtmosphericSounding(this.soundingLevels(), this.selectedElevationMeters())
  );

  // Palette references for UI
  readonly tempPaletteHex = TEMP_PALETTE_HEX;
  readonly humidityPaletteHex = HUMIDITY_PALETTE_HEX;
  readonly rainPaletteHex = RAIN_PALETTE_HEX;
  readonly capePaletteHex = CAPE_PALETTE_HEX;

  // Active NWP Weather Model Name
  readonly nwpModelName = signal<string>('ECMWF IFS 0.25° (Open-Meteo)');

  // Native ECMWF IFS nodes (0.5° spacing over the 0.25° model grid) covering all of Tamil Nadu
  private readonly nLat = ECMWF_NODE_GRID.nLat;
  private readonly nLon = ECMWF_NODE_GRID.nLon;
  private readonly ecmwfMinLat = ECMWF_NODE_GRID.minLat;
  private readonly ecmwfMinLon = ECMWF_NODE_GRID.minLon;
  private readonly ecmwfStep = ECMWF_NODE_GRID.step;

  private gridTemps = new Float32Array(this.nLat * this.nLon);
  /** Node temperatures reduced to sea level — what actually gets interpolated across terrain */
  private gridTempsSeaLevel = new Float32Array(this.nLat * this.nLon);
  private gridHums = new Float32Array(this.nLat * this.nLon);
  private gridWindSpeeds = new Float32Array(this.nLat * this.nLon);
  private gridWindDirs = new Float32Array(this.nLat * this.nLon);
  private gridWindU = new Float32Array(this.nLat * this.nLon);
  private gridWindV = new Float32Array(this.nLat * this.nLon);
  private gridRain24h = new Float32Array(this.nLat * this.nLon);
  private gridCape = new Float32Array(this.nLat * this.nLon);
  /** Elevation of the surface each node's values refer to */
  private gridNodeElev = new Float32Array(this.nLat * this.nLon);

  // Bumped whenever node data or terrain change, so computeds that sample them re-evaluate.
  private readonly gridVersion = signal<number>(0);

  // Live atmospheric anchor signals
  readonly isLoaded = signal<boolean>(false);
  readonly isRefreshing = signal<boolean>(false);
  readonly lastUpdated = signal<string>('');
  /** Where the current numbers come from: a live model fetch, a cached snapshot, or an offline estimate */
  readonly dataStatus = signal<NwpStatus>('estimate');
  readonly fetchError = signal<string | null>(null);
  readonly terrainStatus = signal<'loading' | 'ready' | 'failed'>('loading');

  readonly statusLabel = computed(() => {
    const t = this.lastUpdated();
    switch (this.dataStatus()) {
      case 'live': return `Live NWP${t ? ' · ' + t : ''}`;
      case 'cached': return `Cached NWP${t ? ' · ' + t : ''}`;
      default: return 'Offline estimate';
    }
  });

  readonly baseTemp = signal<number>(31.2);
  readonly baseHumidity = signal<number>(58);
  readonly baseWindSpeed = signal<number>(6.5);
  readonly baseWindDeg = signal<number>(140);

  // Heatmap image URLs (blob: URLs, encoded off the main thread)
  readonly tempDataUrl = signal<string | null>(null);
  readonly humidityDataUrl = signal<string | null>(null);
  readonly rainDataUrl = signal<string | null>(null);
  readonly capeDataUrl = signal<string | null>(null);

  // Recenter request signal
  readonly centerRegionRequest = signal<number>(0);

  requestCenterRegion(): void {
    this.centerRegionRequest.update(n => n + 1);
  }

  private lastInspectPoint: { lat: number; lon: number; screenPoint: { x: number; y: number } } | null = null;

  setElevation(meters: number): void {
    const clamped = Math.max(0, Math.min(13000, Math.round(meters)));
    if (this.selectedElevationMeters() === clamped) return;
    this.selectedElevationMeters.set(clamped);
    // Instant update: the cached 500 m base grids are recoloured through lookup tables
    this.refreshActiveFields();
    if (this.lastInspectPoint) {
      this.inspect(this.lastInspectPoint.lat, this.lastInspectPoint.lon, this.lastInspectPoint.screenPoint);
    }
  }

  readonly isMicroclimateActive = computed(() => {
    const layers = this.ls.layers();
    return layers.some(l => (
      l.id === 'temp-500m' ||
      l.id === 'humidity-500m' ||
      l.id === 'wind-500m' ||
      l.id === 'rain-24h' ||
      l.id === 'cape'
    ) && l.active);
  });

  setRasterMode(mode: 'temp' | 'humidity' | 'wind' | 'rain-24h' | 'cape'): void {
    // Coming from the radar view: zoom to the state so the whole field is visible
    const wasActive = this.isMicroclimateActive();
    this.rasterMode.set(mode);
    const layerForMode: Record<string, string> = {
      temp: 'temp-500m',
      humidity: 'humidity-500m',
      wind: 'wind-500m',
      'rain-24h': 'rain-24h',
      cape: 'cape'
    };
    const opacityForMode: Record<string, number> = {
      temp: 0.85, humidity: 0.85, wind: 0.95, 'rain-24h': 0.85, cape: 0.85
    };
    // Layers are mutually exclusive
    this.ls.setLayerActive('radar', false);
    for (const id of Object.values(layerForMode)) {
      if (id !== layerForMode[mode]) this.ls.setLayerActive(id, false);
    }
    this.ls.setLayerActive(layerForMode[mode], true);
    this.ls.setLayerOpacity(layerForMode[mode], opacityForMode[mode]);

    // Lazily (re)build only the raster that just became visible.
    if (mode !== 'wind') {
      this.ensureField(mode);
    }
    if (!wasActive) this.requestCenterRegion();
  }

  setWindPalette(mode: WindPaletteType): void {
    this.windPaletteMode.set(mode);
  }

  toggleWindPalette(): void {
    this.windPaletteMode.update(m => m === 'cold' ? 'dry' : 'cold');
  }

  turnOffMicroclimate(): void {
    this.ls.setLayerActive('temp-500m', false);
    this.ls.setLayerActive('humidity-500m', false);
    this.ls.setLayerActive('wind-500m', false);
    this.ls.setLayerActive('rain-24h', false);
    this.ls.setLayerActive('cape', false);
    // Layers are mutually exclusive: fall back to radar instead of leaving an empty map
    this.ls.setLayerActive('radar', true);
    this.clearInspection();
  }

  turnOnMicroclimate(mode: 'temp' | 'humidity' | 'wind' | 'rain-24h' | 'cape' = 'temp'): void {
    this.setRasterMode(mode);
  }

  // Real-time click inspection inside the Tamil Nadu microclimate domain
  readonly inspectionInfo = signal<MicroclimateInspectionInfo | null>(null);

  /** Latitude / longitude of a node of the ECMWF grid. */
  private nodeLat(row: number): number {
    return this.ecmwfMinLat + row * this.ecmwfStep;
  }
  private nodeLon(col: number): number {
    return this.ecmwfMinLon + col * this.ecmwfStep;
  }

  /**
   * Plausible statewide baseline used until the first live model fetch arrives (or when offline):
   * a warm, humid monsoon-season pattern in sea-level terms, so terrain cooling still shows.
   */
  private initDefaultSpatialGrid(): void {
    for (let r = 0; r < this.nLat; r++) {
      const lat = this.nodeLat(r);
      for (let c = 0; c < this.nLon; c++) {
        const lon = this.nodeLon(c);
        const idx = r * this.nLon + c;
        const elev = getRegionalElevation(lat, lon);

        const tempSeaLevel = 31.5 - (lat - 10.8) * 0.3 + (lon - 78.3) * 0.15;
        this.gridNodeElev[idx] = elev;
        this.gridTempsSeaLevel[idx] = tempSeaLevel;
        this.gridTemps[idx] = Math.round((tempSeaLevel - elev * LAPSE_RATE_C_PER_M) * 10) / 10;
        this.gridHums[idx] = Math.round(Math.max(40, Math.min(92, 68 + (lon - 78.3) * 3 - (lat - 10.8) * 1.5)));
        const windSpeed = 9.0;
        const windDir = 240;
        this.gridWindSpeeds[idx] = windSpeed;
        this.gridWindDirs[idx] = windDir;
        const rad = (windDir * Math.PI) / 180;
        this.gridWindU[idx] = -Math.sin(rad) * windSpeed;
        this.gridWindV[idx] = -Math.cos(rad) * windSpeed;
        this.gridRain24h[idx] = 0.5;
        this.gridCape[idx] = 1200;
      }
    }
  }

  /**
   * Evaluates 1D Catmull-Rom cubic spline across 4 values with parameter t in [0, 1].
   * Continuous C1 derivatives with neighbor slope (no zero-derivative seams or pillowing).
   */
  private cubicCatmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    const b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
    const c = -0.5 * p0 + 0.5 * p2;
    const d = p1;
    return ((a * t + b) * t + c) * t + d;
  }

  /**
   * 2D Bicubic Catmull-Rom interpolation across the ECMWF node grid.
   * Produces smooth, continuous fields without grid tiles, seams, or pillowing artifacts.
   */
  public interpolateNativeEcmwf(lat: number, lon: number, grid: Float32Array): number {
    const u = (lon - this.ecmwfMinLon) / this.ecmwfStep;
    const v = (lat - this.ecmwfMinLat) / this.ecmwfStep;

    const clampedU = Math.max(0, Math.min(this.nLon - 1.0001, u));
    const clampedV = Math.max(0, Math.min(this.nLat - 1.0001, v));

    const c1 = Math.floor(clampedU);
    const c0 = Math.max(0, c1 - 1);
    const c2 = Math.min(this.nLon - 1, c1 + 1);
    const c3 = Math.min(this.nLon - 1, c1 + 2);
    const tu = clampedU - c1;

    const r1 = Math.floor(clampedV);
    const r0 = Math.max(0, r1 - 1);
    const r2 = Math.min(this.nLat - 1, r1 + 1);
    const r3 = Math.min(this.nLat - 1, r1 + 2);
    const tv = clampedV - r1;

    const row = (r: number) => this.cubicCatmullRom(
      grid[r * this.nLon + c0],
      grid[r * this.nLon + c1],
      grid[r * this.nLon + c2],
      grid[r * this.nLon + c3],
      tu
    );
    return this.cubicCatmullRom(row(r0), row(r1), row(r2), row(r3), tv);
  }

  /** Height of the model surface at a point, i.e. what the node values are valid for. */
  private referenceElevation(lat: number, lon: number): number {
    return Math.max(0, this.interpolateNativeEcmwf(lat, lon, this.gridNodeElev));
  }

  /**
   * Samples genuine NWP weather data at any arbitrary coordinate (lat, lon)
   * using smooth 2D Bicubic Catmull-Rom interpolation across the native ECMWF nodes,
   * coupled with 500-meter physical topographic downscaling.
   */
  public sampleSpatialWeather(lat: number, lon: number): { temp: number; hum: number; windSpeed: number; windDir: number } {
    const elev = getRegionalElevation(lat, lon);
    const elevDiff = elev - this.referenceElevation(lat, lon);
    const oro = orographicFraction(elevDiff);

    const baseTempSeaLevel = this.interpolateNativeEcmwf(lat, lon, this.gridTempsSeaLevel);
    const baseHum = this.interpolateNativeEcmwf(lat, lon, this.gridHums);

    // Vector-based wind interpolation across ECMWF grid
    const u = this.interpolateNativeEcmwf(lat, lon, this.gridWindU);
    const v = this.interpolateNativeEcmwf(lat, lon, this.gridWindV);
    const baseWindSpeed = Math.sqrt(u * u + v * v);
    let baseWindDir = (Math.atan2(-u, -v) * 180) / Math.PI;
    if (baseWindDir < 0) baseWindDir += 360;

    return {
      temp: downscaleTemperature(baseTempSeaLevel, elev),
      hum: downscaleHumidity(baseHum, elevDiff),
      windSpeed: Math.round(baseWindSpeed * windSpeedup(oro) * 10) / 10,
      windDir: Math.round(baseWindDir)
    };
  }

  public sampleSpatialRain(lat: number, lon: number): number {
    const elevDiff = getRegionalElevation(lat, lon) - this.referenceElevation(lat, lon);
    return downscaleRain(
      this.interpolateNativeEcmwf(lat, lon, this.gridRain24h),
      orographicFraction(elevDiff)
    );
  }

  public sampleSpatialCape(lat: number, lon: number): number {
    const elevDiff = getRegionalElevation(lat, lon) - this.referenceElevation(lat, lon);
    return downscaleCape(
      this.interpolateNativeEcmwf(lat, lon, this.gridCape),
      orographicFraction(elevDiff)
    );
  }

  // Windy-style district-HQ weather markers with live metric computation
  readonly citiesWeather = computed(() => {
    this.gridVersion();
    const alt = this.selectedElevationMeters();
    const slice = this.currentSoundingState();
    const groundRefT = this.soundingLevels()[0]?.tempC ?? 31.2;
    const deltaT = alt > 0 ? slice.temperatureC - groundRefT : 0;
    const groundRefH = this.soundingLevels()[0]?.humidityPercent ?? 58;
    const deltaH = alt > 0 ? slice.humidityPercent - groundRefH : 0;

    return TAMIL_NADU_CITIES.map(city => {
      const sample = this.sampleSpatialWeather(city.lat, city.lon);
      const temp = Math.round((sample.temp + deltaT) * 10) / 10;
      const hum = Math.round(Math.min(100, Math.max(10, sample.hum + deltaH)));
      const wind = Math.round(sample.windSpeed * 10) / 10;
      const rain = this.sampleSpatialRain(city.lat, city.lon);
      const cape = this.sampleSpatialCape(city.lat, city.lon);

      return {
        ...city,
        temp,
        hum,
        wind,
        rain,
        cape
      };
    });
  });

  // Contrasting landmark spots (high range / coast / wind gap) sampled from the same fields
  readonly landmarks = computed(() => {
    this.gridVersion();
    const alt = this.selectedElevationMeters();
    const groundRefT = this.soundingLevels()[0]?.tempC ?? 31.2;
    const deltaT = alt > 0 ? this.currentSoundingState().temperatureC - groundRefT : 0;
    const groundRefH = this.soundingLevels()[0]?.humidityPercent ?? 58;
    const deltaH = alt > 0 ? this.currentSoundingState().humidityPercent - groundRefH : 0;

    return TAMIL_NADU_LANDMARKS.map(l => {
      const sample = this.sampleSpatialWeather(l.lat, l.lon);
      return {
        ...l,
        elev: getRegionalElevation(l.lat, l.lon),
        temp: Math.round((sample.temp + deltaT) * 10) / 10,
        hum: Math.round(Math.min(100, Math.max(10, sample.hum + deltaH))),
        wind: Math.round(sample.windSpeed * 10) / 10
      };
    });
  });

  // Field-resolution cache: each 500 m raster is built lazily and reused until the
  // elevation slice or the underlying NWP data changes.
  private generatedElevation = -999999;
  private generatedModes = new Set<RasterMode>();

  private autoRefreshTimer: any = null;
  private fetchInFlight = false;
  private cachedAtMs = 0;

  constructor() {
    // Lazily (re)build only the raster for whichever microclimate layer is visible,
    // so switching Temp -> Humidity -> Rain etc. never rebuilds all four rasters.
    effect(() => {
      const active = this.ls.layers().find(l => l.active);
      const mode = active ? LAYER_TO_RASTER_MODE[active.id] : undefined;
      if (mode) this.ensureField(mode);
    });

    this.initDefaultSpatialGrid();
    const hadCache = this.loadCachedSnapshot();
    void this.loadTerrain();

    // A snapshot younger than the refresh interval is reused as-is (survives page reloads)
    const age = Date.now() - this.cachedAtMs;
    if (hadCache && age < NWP_REFRESH_MS) {
      this.isLoaded.set(true);
    } else {
      void this.fetchLiveAnchorData();
    }
    this.startAutoRefresh();
  }

  ngOnDestroy(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
    this.gridWorker?.terminate();
    this.gridWorker = null;
    for (const url of [this.tempDataUrl(), this.humidityDataUrl(), this.rainDataUrl(), this.capeDataUrl()]) {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    }
  }

  private startAutoRefresh(): void {
    if (typeof window === 'undefined') return;
    this.autoRefreshTimer = setInterval(() => {
      void this.fetchLiveAnchorData();
    }, NWP_REFRESH_MS);
  }

  // ── Terrain ─────────────────────────────────────────────────────────────

  /** Loads the baked 500 m elevation raster (gzip, ~0.8 MB) once at start-up. */
  private async loadTerrain(): Promise<void> {
    try {
      const res = await fetch(TERRAIN_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let buf = await res.arrayBuffer();

      // Some servers send the file with `Content-Encoding: gzip` (fetch has then already inflated
      // it); others deliver the raw .gz. Inflate only if the gzip header is still there.
      const head = new Uint8Array(buf, 0, 2);
      if (head[0] === 0x1f && head[1] === 0x8b) {
        if (typeof DecompressionStream === 'undefined') {
          throw new Error('DecompressionStream is not supported in this browser');
        }
        buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      }
      setTerrainRaster(new Uint16Array(buf));
      this.syncTerrainToWorker();
      this.terrainStatus.set('ready');

      // Offline-estimate nodes were laid out before terrain existed: re-reference them to the DEM
      if (this.dataStatus() === 'estimate') this.initDefaultSpatialGrid();
      this.gridVersion.update(v => v + 1);
      this.rebuildBaseGrids();
    } catch (e) {
      console.warn('[MicroclimateService] Terrain raster unavailable, assuming flat ground:', e);
      this.terrainStatus.set('failed');
    }
  }

  private syncTerrainToWorker(): void {
    const terrain = getTerrainRaster();
    const worker = this.getGridWorker();
    // Copied, not transferred: the main thread keeps its own raster for point lookups
    if (terrain && worker) worker.postMessage({ type: 'terrain', data: terrain.slice() });
  }

  // ── Live model data ─────────────────────────────────────────────────────

  private applyNodeValues(s: NwpSnapshot): void {
    const n = this.nLat * this.nLon;
    for (let i = 0; i < n; i++) {
      this.gridTemps[i] = s.temps[i];
      this.gridHums[i] = s.hums[i];
      this.gridWindSpeeds[i] = s.windSpeeds[i];
      this.gridWindDirs[i] = s.windDirs[i];
      const rad = (s.windDirs[i] * Math.PI) / 180;
      this.gridWindU[i] = -Math.sin(rad) * s.windSpeeds[i];
      this.gridWindV[i] = -Math.cos(rad) * s.windSpeeds[i];
      this.gridRain24h[i] = s.rain24h[i];
      this.gridCape[i] = s.cape[i];
      this.gridNodeElev[i] = s.elev[i];
      this.gridTempsSeaLevel[i] = s.temps[i] + s.elev[i] * LAPSE_RATE_C_PER_M;
    }
    if (s.sounding) this.soundingLevels.set(s.sounding);
    if (s.base) {
      this.baseTemp.set(s.base.temp);
      this.baseHumidity.set(s.base.hum);
      this.baseWindSpeed.set(s.base.windSpeed);
      this.baseWindDeg.set(s.base.windDeg);
    }
  }

  private formatIst(ms: number): string {
    return new Date(ms).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    }) + ' IST';
  }

  private loadCachedSnapshot(): boolean {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(NWP_CACHE_KEY) : null;
      if (!raw) return false;
      const s = JSON.parse(raw) as NwpSnapshot;
      const n = this.nLat * this.nLon;
      const ok = [s.temps, s.hums, s.windSpeeds, s.windDirs, s.rain24h, s.cape, s.elev]
        .every(a => Array.isArray(a) && a.length === n && a.every(v => Number.isFinite(v)));
      if (!ok || !Number.isFinite(s.ts)) return false;
      this.applyNodeValues(s);
      this.cachedAtMs = s.ts;
      this.dataStatus.set('cached');
      this.lastUpdated.set(this.formatIst(s.ts));
      return true;
    } catch {
      return false;
    }
  }

  private saveSnapshot(s: NwpSnapshot): void {
    try {
      localStorage.setItem(NWP_CACHE_KEY, JSON.stringify(s));
    } catch { /* storage full or blocked: the next load simply refetches */ }
  }

  private async fetchJson(url: string): Promise<any> {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), NWP_FETCH_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
      if (!res || !res.ok) throw new Error(`Open-Meteo HTTP ${res?.status ?? 'error'}`);
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** One request for all 130 ECMWF nodes (a few seconds; ~260 KB). */
  private async fetchNodeGrid(): Promise<Omit<NwpSnapshot, 'ts' | 'sounding' | 'base'>> {
    const lats: number[] = [];
    const lons: number[] = [];
    for (let r = 0; r < this.nLat; r++) {
      for (let c = 0; c < this.nLon; c++) {
        lats.push(Math.round(this.nodeLat(r) * 1000) / 1000);
        lons.push(Math.round(this.nodeLon(c) * 1000) / 1000);
      }
    }
    // CAPE is hourly in ECMWF IFS; cape_max and precipitation_sum are daily.
    const url = `${OPEN_METEO_FORECAST}?latitude=${lats.join(',')}&longitude=${lons.join(',')}` +
      '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation' +
      '&hourly=cape&daily=precipitation_sum,cape_max&models=ecmwf_ifs025&forecast_days=2';
    const data = await this.fetchJson(url);
    const n = this.nLat * this.nLon;
    if (!Array.isArray(data) || data.length !== n) {
      throw new Error(`Unexpected model response (${Array.isArray(data) ? data.length : 'not a list'} of ${n} nodes)`);
    }

    const nowIso = new Date().toISOString().slice(0, 13);
    const out = {
      temps: new Array<number>(n), hums: new Array<number>(n), windSpeeds: new Array<number>(n),
      windDirs: new Array<number>(n), rain24h: new Array<number>(n), cape: new Array<number>(n),
      elev: new Array<number>(n)
    };
    for (let i = 0; i < n; i++) {
      const cur = data[i]?.current;
      const daily = data[i]?.daily;
      const hourly = data[i]?.hourly;
      if (!cur) throw new Error(`Model response is missing current conditions for node ${i}`);
      out.temps[i] = cur.temperature_2m ?? this.gridTemps[i];
      out.hums[i] = cur.relative_humidity_2m ?? this.gridHums[i];
      out.windSpeeds[i] = cur.wind_speed_10m ?? this.gridWindSpeeds[i];
      out.windDirs[i] = cur.wind_direction_10m ?? this.gridWindDirs[i];
      // Height of the surface these values were downscaled to (falls back to our own terrain)
      out.elev[i] = Number.isFinite(data[i]?.elevation)
        ? data[i].elevation
        : getRegionalElevation(this.nodeLat(Math.floor(i / this.nLon)), this.nodeLon(i % this.nLon));

      const rainToday = daily?.precipitation_sum?.[0] ?? 0;
      const rainTomorrow = daily?.precipitation_sum?.[1] ?? 0;
      out.rain24h[i] = Math.round(Math.max(rainToday, rainTomorrow, cur.precipitation ?? 0) * 10) / 10;

      let hIdx = (hourly?.time ?? []).findIndex((t: string) => t.startsWith(nowIso));
      if (hIdx < 0) hIdx = 0;
      const capeNow = hourly?.cape?.[hIdx] ?? 0;
      out.cape[i] = Math.round(Math.max(capeNow, daily?.cape_max?.[0] ?? 0, daily?.cape_max?.[1] ?? 0));
    }
    return out;
  }

  /** ECMWF isobaric sounding for the middle of the state (ground to ~13 km). */
  private async fetchSounding(): Promise<{ levels: AtmosphericSoundingLevel[]; base: NwpSnapshot['base'] } | null> {
    const c = this.center;
    const url = `${OPEN_METEO_FORECAST}?latitude=${c.lat}&longitude=${c.lng}` +
      '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m' +
      '&hourly=temperature_1000hPa,temperature_850hPa,temperature_700hPa,temperature_500hPa,temperature_300hPa,temperature_250hPa,temperature_200hPa,temperature_150hPa,' +
      'relative_humidity_1000hPa,relative_humidity_850hPa,relative_humidity_700hPa,relative_humidity_500hPa,relative_humidity_300hPa,relative_humidity_250hPa,relative_humidity_200hPa,relative_humidity_150hPa,' +
      'windspeed_1000hPa,windspeed_850hPa,windspeed_700hPa,windspeed_500hPa,windspeed_300hPa,windspeed_250hPa,windspeed_200hPa,windspeed_150hPa,' +
      'winddirection_1000hPa,winddirection_850hPa,winddirection_700hPa,winddirection_500hPa,winddirection_300hPa,winddirection_250hPa,winddirection_200hPa,winddirection_150hPa' +
      '&models=ecmwf_ifs025&forecast_days=1';
    const sData = await this.fetchJson(url);
    if (!sData?.current || !sData.hourly?.time?.length) return null;

    const cur = sData.current;
    const base = {
      temp: cur.temperature_2m ?? 31.2,
      hum: cur.relative_humidity_2m ?? 58,
      windSpeed: cur.wind_speed_10m ?? 6.5,
      windDeg: cur.wind_direction_10m ?? 140
    };
    const nowIsoPrefix = new Date().toISOString().slice(0, 13);
    let hIdx = sData.hourly.time.findIndex((t: string) => t.startsWith(nowIsoPrefix));
    if (hIdx < 0) hIdx = 0;
    const h = sData.hourly;

    const levels: AtmosphericSoundingLevel[] = [
      {
        altitudeMeters: 0, pressureHpa: 1013, label: 'Ground Level (Surface)',
        tempC: base.temp, humidityPercent: base.hum, windSpeedKmh: base.windSpeed, windDirectionDeg: base.windDeg
      },
      {
        altitudeMeters: 500, pressureHpa: 950, label: '500m Boundary Layer',
        tempC: (h.temperature_1000hPa?.[hIdx] ?? base.temp) - 1.8,
        humidityPercent: Math.min(100, (h.relative_humidity_1000hPa?.[hIdx] ?? base.hum) + 6),
        windSpeedKmh: (h.windspeed_1000hPa?.[hIdx] ?? base.windSpeed) * 1.3,
        windDirectionDeg: h.winddirection_1000hPa?.[hIdx] ?? base.windDeg
      },
      {
        altitudeMeters: 1500, pressureHpa: 850, label: '1.5 km (850 hPa Cloud Base)',
        tempC: h.temperature_850hPa?.[hIdx] ?? (base.temp - 9.5),
        humidityPercent: h.relative_humidity_850hPa?.[hIdx] ?? 75,
        windSpeedKmh: h.windspeed_850hPa?.[hIdx] ?? 18,
        windDirectionDeg: h.winddirection_850hPa?.[hIdx] ?? 95
      },
      {
        altitudeMeters: 3000, pressureHpa: 700, label: '3.0 km (700 hPa Lower Tropo)',
        tempC: h.temperature_700hPa?.[hIdx] ?? (base.temp - 19.5),
        humidityPercent: h.relative_humidity_700hPa?.[hIdx] ?? 60,
        windSpeedKmh: h.windspeed_700hPa?.[hIdx] ?? 20,
        windDirectionDeg: h.winddirection_700hPa?.[hIdx] ?? 90
      },
      {
        altitudeMeters: 5500, pressureHpa: 500, label: '5.5 km (500 hPa Freezing)',
        tempC: h.temperature_500hPa?.[hIdx] ?? -4.0,
        humidityPercent: h.relative_humidity_500hPa?.[hIdx] ?? 42,
        windSpeedKmh: h.windspeed_500hPa?.[hIdx] ?? 22,
        windDirectionDeg: h.winddirection_500hPa?.[hIdx] ?? 85
      },
      {
        altitudeMeters: 9200, pressureHpa: 300, label: '9.2 km (300 hPa Upper Tropo)',
        tempC: h.temperature_300hPa?.[hIdx] ?? -31.0,
        humidityPercent: h.relative_humidity_300hPa?.[hIdx] ?? 32,
        windSpeedKmh: h.windspeed_300hPa?.[hIdx] ?? 35,
        windDirectionDeg: h.winddirection_300hPa?.[hIdx] ?? 75
      },
      {
        altitudeMeters: 11800, pressureHpa: 200, label: '11.8 km (200 hPa Jet Level)',
        tempC: h.temperature_200hPa?.[hIdx] ?? -52.0,
        humidityPercent: h.relative_humidity_200hPa?.[hIdx] ?? 28,
        windSpeedKmh: h.windspeed_200hPa?.[hIdx] ?? 45,
        windDirectionDeg: h.winddirection_200hPa?.[hIdx] ?? 70
      },
      {
        altitudeMeters: 13000, pressureHpa: 150, label: '13.0 km (150 hPa Tropopause)',
        tempC: h.temperature_150hPa?.[hIdx] ?? -64.0,
        humidityPercent: h.relative_humidity_150hPa?.[hIdx] ?? 25,
        windSpeedKmh: h.windspeed_150hPa?.[hIdx] ?? 38,
        windDirectionDeg: h.winddirection_150hPa?.[hIdx] ?? 65
      }
    ];
    return { levels, base };
  }

  async fetchLiveAnchorData(): Promise<void> {
    if (this.fetchInFlight) return;
    this.fetchInFlight = true;
    this.isRefreshing.set(true);
    try {
      // Node grid and sounding in parallel: total wait is the slower of the two, not the sum
      const [nodes, sounding] = await Promise.allSettled([this.fetchNodeGrid(), this.fetchSounding()]);

      if (nodes.status === 'rejected') throw nodes.reason;
      const snapshot: NwpSnapshot = {
        ...nodes.value,
        ts: Date.now(),
        sounding: sounding.status === 'fulfilled' && sounding.value ? sounding.value.levels : null,
        base: sounding.status === 'fulfilled' && sounding.value ? sounding.value.base : null
      };
      this.applyNodeValues(snapshot);
      this.saveSnapshot(snapshot);
      this.cachedAtMs = snapshot.ts;
      this.dataStatus.set('live');
      this.lastUpdated.set(this.formatIst(snapshot.ts));
      this.fetchError.set(null);
      this.gridVersion.update(v => v + 1);
      this.rebuildBaseGrids();
    } catch (e) {
      // Keep whatever data we already have (cache or estimate) and say so
      const message = e instanceof Error ? e.message : 'Model request failed';
      this.fetchError.set(message);
      console.warn('[MicroclimateService] Live model fetch failed, keeping previous data:', message);
    } finally {
      this.isLoaded.set(true);
      this.isRefreshing.set(false);
      this.fetchInFlight = false;
    }
  }

  // ── 500 m base grids ────────────────────────────────────────────────────

  // Pre-computed spatial base grids (841 x 1121 = 942,761 cells).
  // Prevents re-running bicubic interpolation on every cell during altitude sliding.
  private cachedBaseTempGrid: Float32Array | null = null;
  private cachedBaseHumGrid: Float32Array | null = null;
  private cachedBaseRainGrid: Float32Array | null = null;
  private cachedBaseCapeGrid: Float32Array | null = null;

  // Background builder for the base grids; null where Web Workers are unavailable (e.g. tests)
  private gridWorker: Worker | null = null;
  private gridRequestId = 0;

  private gridInput(): MicroclimateGridInput {
    return {
      tempsSeaLevel: this.gridTempsSeaLevel,
      hums: this.gridHums,
      rain24h: this.gridRain24h,
      cape: this.gridCape,
      nodeElev: this.gridNodeElev,
      nLat: this.nLat,
      nLon: this.nLon,
      nodeMinLat: this.ecmwfMinLat,
      nodeMinLon: this.ecmwfMinLon,
      nodeStep: this.ecmwfStep,
      bounds: this.bounds,
      width: REGIONAL_HEATMAP_WIDTH,
      height: REGIONAL_HEATMAP_HEIGHT
    };
  }

  private applyBaseGrids(grids: MicroclimateBaseGrids): void {
    this.cachedBaseTempGrid = grids.temp;
    this.cachedBaseHumGrid = grids.hum;
    this.cachedBaseRainGrid = grids.rain;
    this.cachedBaseCapeGrid = grids.cape;
  }

  /** Synchronous build, used when no worker is available. */
  private initBaseSpatialGrids(): void {
    this.applyBaseGrids(buildMicroclimateBaseGrids(this.gridInput(), getTerrainRaster()));
  }

  private getGridWorker(): Worker | null {
    if (this.gridWorker || typeof Worker === 'undefined') return this.gridWorker;
    try {
      const worker = new Worker(new URL('../../workers/microclimate-grid.worker', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ id: number; grids?: MicroclimateBaseGrids; error?: string }>) => {
        const { id, grids, error } = event.data;
        // Ignore results superseded by a newer refresh
        if (id !== this.gridRequestId) return;
        if (grids) {
          this.applyBaseGrids(grids);
        } else {
          console.warn('[MicroclimateService] Worker grid build failed, building on main thread:', error);
          this.initBaseSpatialGrids();
        }
        this.refreshActiveFields();
      };
      this.gridWorker = worker;
      this.syncTerrainToWorker();
    } catch (e) {
      console.warn('[MicroclimateService] Grid worker unavailable, building on main thread:', e);
      this.gridWorker = null;
    }
    return this.gridWorker;
  }

  /** Rebuilds the base grids from fresh node data or terrain, off the main thread when possible. */
  private rebuildBaseGrids(): void {
    const id = ++this.gridRequestId;
    const worker = this.getGridWorker();
    if (worker) {
      // Copies (not transfers) the small node arrays; the service keeps using its own
      worker.postMessage({ type: 'build', id, input: this.gridInput() });
      return;
    }
    this.initBaseSpatialGrids();
    this.refreshActiveFields();
  }

  /** True once the base grids exist; otherwise starts building them and returns false. */
  private ensureBaseGrids(): boolean {
    if (this.cachedBaseTempGrid) return true;
    if (this.gridWorker || this.getGridWorker()) {
      // Result handler regenerates the visible heatmap when it arrives
      if (this.gridRequestId === 0) this.rebuildBaseGrids();
      return false;
    }
    this.initBaseSpatialGrids();
    return true;
  }

  /**
   * Builds the requested 500 m raster ONLY if it is missing for the current elevation
   * slice. Results are cached per mode + elevation so repeated switches are instant.
   */
  private ensureField(mode: RasterMode): void {
    if (typeof document === 'undefined') return;
    const elev = this.selectedElevationMeters();
    if (this.generatedElevation !== elev) {
      this.generatedModes.clear();
      this.generatedElevation = elev;
    }
    if (this.generatedModes.has(mode)) return;
    if (!this.ensureBaseGrids()) return;
    switch (mode) {
      case 'temp':
        this.generateTemperatureHeatmap();
        break;
      case 'humidity':
        this.generateHumidityHeatmap();
        break;
      case 'rain-24h':
        this.generateRainHeatmap();
        break;
      case 'cape':
        this.generateCapeHeatmap();
        break;
    }
    this.generatedModes.add(mode);
  }

  /**
   * Rebuilds the active visible raster immediately (instant altitude response).
   */
  private refreshActiveFields(): void {
    this.generatedElevation = this.selectedElevationMeters();
    this.generatedModes.clear();
    const active = this.ls.layers().find(l => l.active);
    const mode = active ? LAYER_TO_RASTER_MODE[active.id] : undefined;
    if (mode) this.ensureField(mode);
  }

  // ── Heatmap rendering ───────────────────────────────────────────────────

  private heatmapTokens: Record<RasterMode, number> = { temp: 0, humidity: 0, 'rain-24h': 0, cape: 0 };

  /**
   * Paints one heatmap through `fill` (which writes packed RGBA into a Uint32 view), then encodes it
   * as a PNG asynchronously. Encoding runs off the main thread; if a newer render of the same layer
   * starts first (e.g. while dragging the altitude slider) the older result is dropped.
   */
  private renderHeatmap(mode: RasterMode, target: WritableSignal<string | null>, fill: (data32: Uint32Array) => void): void {
    const w = REGIONAL_HEATMAP_WIDTH;
    const h = REGIONAL_HEATMAP_HEIGHT;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const imgData = ctx.createImageData(w, h);
    fill(new Uint32Array(imgData.data.buffer));
    ctx.putImageData(imgData, 0, 0);

    const token = ++this.heatmapTokens[mode];
    canvas.toBlob(blob => {
      if (!blob || token !== this.heatmapTokens[mode]) return;
      const previous = target();
      target.set(URL.createObjectURL(blob));
      // Give MapLibre time to swap to the new image before releasing the old one
      if (previous?.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(previous), 10000);
    }, 'image/png');
  }

  /**
   * Temperature heatmap: downscaled NWP temperature per cell, shifted by the sounding profile at
   * the selected altitude.
   */
  private generateTemperatureHeatmap(): void {
    const baseGrid = this.cachedBaseTempGrid;
    if (!baseGrid) return;

    const alt = this.selectedElevationMeters();
    const groundRefT = this.soundingLevels()[0]?.tempC ?? 31.2;
    const altDeltaT = alt > 0 ? this.currentSoundingState().temperatureC - groundRefT : 0;
    const lut = getTempLut();
    const last = lut.length - 1;

    this.renderHeatmap('temp', this.tempDataUrl, data32 => {
      for (let i = 0; i < baseGrid.length; i++) {
        const idx = Math.round((baseGrid[i] + altDeltaT - TEMP_LUT_MIN) / TEMP_LUT_STEP);
        data32[i] = lut[idx < 0 ? 0 : idx > last ? last : idx];
      }
    });
  }

  private generateHumidityHeatmap(): void {
    const baseGrid = this.cachedBaseHumGrid;
    if (!baseGrid) return;

    const alt = this.selectedElevationMeters();
    const groundRefH = this.soundingLevels()[0]?.humidityPercent ?? 58;
    const altDeltaH = alt > 0 ? this.currentSoundingState().humidityPercent - groundRefH : 0;
    const lut = getHumidityLut();

    this.renderHeatmap('humidity', this.humidityDataUrl, data32 => {
      for (let i = 0; i < baseGrid.length; i++) {
        const rh = Math.min(100, Math.max(10, baseGrid[i] + altDeltaH));
        data32[i] = lut[Math.round(rh)];
      }
    });
  }

  /**
   * 24-Hour Extreme Rain Forecast heatmap from the ECMWF IFS model.
   */
  private generateRainHeatmap(): void {
    const baseGrid = this.cachedBaseRainGrid;
    if (!baseGrid) return;
    const lut = getRainLut();
    const last = lut.length - 1;

    this.renderHeatmap('rain-24h', this.rainDataUrl, data32 => {
      for (let i = 0; i < baseGrid.length; i++) {
        const idx = Math.round(baseGrid[i] * 10);
        data32[i] = lut[idx > last ? last : idx];
      }
    });
  }

  /**
   * Convective Available Potential Energy (CAPE) instability heatmap from the ECMWF IFS model.
   */
  private generateCapeHeatmap(): void {
    const baseGrid = this.cachedBaseCapeGrid;
    if (!baseGrid) return;
    const lut = getCapeLut();
    const last = lut.length - 1;

    this.renderHeatmap('cape', this.capeDataUrl, data32 => {
      for (let i = 0; i < baseGrid.length; i++) {
        const idx = Math.round(baseGrid[i]);
        data32[i] = lut[idx > last ? last : idx];
      }
    });
  }

  // --- Colormaps with User-Specified Palettes ---

  /**
   * Sample Temperature color using Palette 1 calibrated across physical temperature range:
   * #264653 (Deep teal slate / cold / high altitude): <= 18°C
   * #2a9d8f (Persian green / cool peaks): ~ 22°C
   * #e9c46a (Warm saffron yellow / mild): ~ 26°C
   * #f4a261 (Sandy peach / warm plains): ~ 30°C
   * #e76f51 (Coral red / hot plains): >= 34°C
   * Fixed thresholds allow altitude temperature drop to directly reflect on the map colors!
   */
  public sampleTemperatureColor(temp: number): [number, number, number] {
    return sampleStops(TEMP_STOPS, temp);
  }

  public sampleRainColor(mm: number): [number, number, number] {
    return sampleStops(RAIN_STOPS, mm);
  }

  public sampleCapeColor(cape: number): [number, number, number] {
    return sampleStops(CAPE_STOPS, cape);
  }

  /**
   * Sample Humidity color using Palette 2:
   * #f7f7ef (Off-white), #ddddd4 (Platinum), #9fb9cb (Powder blue), #355c77 (Deep ocean blue), #07253a (Midnight navy)
   */
  public sampleHumidityColor(rh: number): [number, number, number] {
    return sampleStops(HUMIDITY_STOPS, rh);
  }

  // --- Real-time Location Inspector ---

  inspect(lat: number, lon: number, screenPoint: { x: number; y: number }): boolean {
    if (
      lat < this.bounds.minLat ||
      lat > this.bounds.maxLat ||
      lon < this.bounds.minLon ||
      lon > this.bounds.maxLon
    ) {
      this.inspectionInfo.set(null);
      return false;
    }

    const groundElev = getRegionalElevation(lat, lon);
    const alt = this.selectedElevationMeters();
    const slice = this.currentSoundingState();
    const sample = this.sampleSpatialWeather(lat, lon);

    let temp = sample.temp;
    let rh = sample.hum;
    let windSpeed = sample.windSpeed;
    let windDeg = sample.windDir;

    if (alt > 0) {
      const groundRefT = this.soundingLevels()[0]?.tempC ?? 31.2;
      const altDeltaT = slice.temperatureC - groundRefT;
      temp = Math.round((sample.temp + altDeltaT) * 10) / 10;

      const groundRefH = this.soundingLevels()[0]?.humidityPercent ?? 58;
      const altDeltaH = slice.humidityPercent - groundRefH;
      rh = Math.round(Math.min(100, Math.max(10, sample.hum + altDeltaH)));

      // Blend speed linearly from surface → sounding across 0–5500m
      const windFrac = Math.min(1.0, alt / 5500);
      windSpeed = Math.round((sample.windSpeed * (1 - windFrac) + slice.windSpeedKmh * windFrac) * 10) / 10;
      // Direction shifts in above 500m
      if (alt > 500) {
        const dirFrac = Math.min(1.0, (alt - 500) / 5000);
        windDeg = Math.round(blendDirectionDeg(windDeg, slice.windDirectionDeg, dirFrac)) % 360;
      }
    }

    const rainMm = this.sampleSpatialRain(lat, lon);
    const rainRisk = getRainRiskLabel(rainMm);
    const capeJkg = this.sampleSpatialCape(lat, lon);
    const capeRisk = getCapeRiskLabel(capeJkg);

    const { city, km } = nearestCity(lat, lon);
    const place = km < 6 ? `${city.name} area` : `${Math.round(km)} km from ${city.name}`;
    const zone = `${describeTerrain(groundElev)} · ${place}`;

    this.lastInspectPoint = { lat, lon, screenPoint };

    this.inspectionInfo.set({
      x: screenPoint.x,
      y: screenPoint.y,
      lat,
      lon,
      groundElevationMeters: groundElev,
      sliceElevationMeters: alt,
      sliceLabel: slice.levelLabel,
      temperatureC: temp,
      humidityPercent: rh,
      windSpeedKmh: windSpeed,
      windDirectionDeg: windDeg,
      windDirectionLabel: degToCompass(windDeg),
      rain24hMm: rainMm,
      rainRiskLabel: rainRisk,
      capeJkg: capeJkg,
      capeRiskLabel: capeRisk,
      zone
    });

    return true;
  }

  clearInspection(): void {
    this.lastInspectPoint = null;
    this.inspectionInfo.set(null);
  }
}
