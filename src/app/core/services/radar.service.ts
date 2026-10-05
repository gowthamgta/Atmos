import { Injectable, signal, computed, OnDestroy } from '@angular/core';
import { GifReader } from 'omggif';
import {
  IMD_RADAR_STATIONS,
  RadarStationConfig,
  RadarProductKey,
  RadarObservationTiming,
  RadarHoverInfo,
  RadarFieldData,
  RadarPaletteEntry,
  ProcessedRadarResult
} from '../domain/models/radar.model';

export const RADAR_COLOR_STOPS = [
  { val: 0.0,  r: 37,  g: 99,  b: 235, a: 0.00 }, // Transparent
  { val: 0.5,  r: 30,  g: 64,  b: 215, a: 0.65 }, // Blue (Light Echo, 12 - 18 dBZ)
  { val: 1.2,  r: 14,  g: 165, b: 233, a: 0.82 }, // Sky Blue / Cyan (18 - 25 dBZ)
  { val: 2.0,  r: 34,  g: 197, b: 94,  a: 0.90 }, // Green (Moderate Rain, 26 - 35 dBZ)
  { val: 3.0,  r: 250, g: 204, b: 21,  a: 0.96 }, // Yellow (Heavy Rain, 36 - 42 dBZ)
  { val: 3.7,  r: 249, g: 115, b: 22,  a: 0.98 }, // Vibrant Orange (Intense Core, 42 - 48 dBZ)
  { val: 4.4,  r: 239, g: 68,  b: 68,  a: 1.00 }, // Red (Torrential Rain, 48 - 55 dBZ)
  { val: 5.2,  r: 168, g: 85,  b: 247, a: 1.00 }  // Purple (Severe Storm / Hail, 55+ dBZ)
];

export function sampleRadarColorRamp(v: number): [number, number, number, number] {
  if (v <= RADAR_COLOR_STOPS[0].val) return [0, 0, 0, 0];
  if (v >= RADAR_COLOR_STOPS[RADAR_COLOR_STOPS.length - 1].val) {
    const last = RADAR_COLOR_STOPS[RADAR_COLOR_STOPS.length - 1];
    return [last.r, last.g, last.b, Math.round(last.a * 255)];
  }
  for (let i = 0; i < RADAR_COLOR_STOPS.length - 1; i++) {
    const s0 = RADAR_COLOR_STOPS[i];
    const s1 = RADAR_COLOR_STOPS[i + 1];
    if (v >= s0.val && v <= s1.val) {
      const t = (v - s0.val) / (s1.val - s0.val);
      const smoothT = t * t * (3 - 2 * t);
      const cr = Math.round(s0.r + (s1.r - s0.r) * smoothT);
      const cg = Math.round(s0.g + (s1.g - s0.g) * smoothT);
      const cb = Math.round(s0.b + (s1.b - s0.b) * smoothT);
      const ca = Math.round((s0.a + (s1.a - s0.a) * smoothT) * 255);
      return [cr, cg, cb, ca];
    }
  }
  return [0, 0, 0, 0];
}

// ── Radial interference (spoke) removal ──
// Sun strikes and RF interference paint long, thin wedges that point straight at the radar.
// Real rain is spread across neighbouring azimuths; a spoke is not. Each 0.5° ray's echo fill is
// compared with the rays 3°–6° to either side, and rays that stand out alone are cleared.
const SPOKE_AZIMUTH_BINS = 720;
const SPOKE_MIN_FILL = 0.2;
const SPOKE_FLANK_RATIO = 0.25;
const SPOKE_MIN_RADIUS_PX = 24;
const spokeGeometryCache = new Map<number, { bins: Int16Array; totals: Float64Array }>();

function getSpokeGeometry(size: number): { bins: Int16Array; totals: Float64Array } {
  let geom = spokeGeometryCache.get(size);
  if (geom) return geom;
  const half = size / 2;
  const maxR = half - 2;
  const bins = new Int16Array(size * size).fill(-1);
  const totals = new Float64Array(SPOKE_AZIMUTH_BINS);
  for (let y = 0; y < size; y++) {
    const dy = y - half;
    for (let x = 0; x < size; x++) {
      const dx = x - half;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r < SPOKE_MIN_RADIUS_PX || r > maxR) continue;
      let a = Math.atan2(dy, dx);
      if (a < 0) a += 2 * Math.PI;
      const bin = Math.floor((a / (2 * Math.PI)) * SPOKE_AZIMUTH_BINS) % SPOKE_AZIMUTH_BINS;
      bins[y * size + x] = bin;
      totals[bin]++;
    }
  }
  geom = { bins, totals };
  spokeGeometryCache.set(size, geom);
  return geom;
}

/**
 * Clears radial interference spokes from a square radar field centred on the radar.
 * Returns the number of cleared pixels.
 */
export function removeRadialInterference(grid: Float32Array, size: number): number {
  const { bins, totals } = getSpokeGeometry(size);
  const echo = new Float64Array(SPOKE_AZIMUTH_BINS);
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > 0 && bins[i] >= 0) echo[bins[i]]++;
  }
  const fill = new Float64Array(SPOKE_AZIMUTH_BINS);
  for (let a = 0; a < SPOKE_AZIMUTH_BINS; a++) {
    fill[a] = totals[a] > 0 ? echo[a] / totals[a] : 0;
  }

  const spoke = new Uint8Array(SPOKE_AZIMUTH_BINS);
  let anySpoke = false;
  for (let a = 0; a < SPOKE_AZIMUTH_BINS; a++) {
    if (fill[a] < SPOKE_MIN_FILL) continue;
    let flankSum = 0;
    let flankCount = 0;
    for (let k = 6; k <= 12; k++) {
      flankSum += fill[(a + k) % SPOKE_AZIMUTH_BINS] + fill[(a - k + SPOKE_AZIMUTH_BINS) % SPOKE_AZIMUTH_BINS];
      flankCount += 2;
    }
    if (flankSum / flankCount <= SPOKE_FLANK_RATIO * fill[a]) {
      // Widen by 1° each side to catch the wedge's tapered edges
      for (let k = -2; k <= 2; k++) spoke[(a + k + SPOKE_AZIMUTH_BINS) % SPOKE_AZIMUTH_BINS] = 1;
      anySpoke = true;
    }
  }
  if (!anySpoke) return 0;

  let removed = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > 0 && bins[i] >= 0 && spoke[bins[i]] === 1) {
      grid[i] = 0;
      removed++;
    }
  }
  return removed;
}

@Injectable({ providedIn: 'root' })
export class RadarService implements OnDestroy {
  readonly stations = IMD_RADAR_STATIONS;

  // Active Station & Product Signals
  readonly activeStationId = signal<string>('karaikal');
  readonly activeStation = computed<RadarStationConfig>(() => {
    const id = this.activeStationId();
    return this.stations.find(s => s.id === id) || this.stations[0];
  });

  readonly activeProduct = signal<RadarProductKey>('caz');
  readonly transparentMode = signal<boolean>(true);
  readonly showRangeRings = signal<boolean>(false);
  readonly radarOpacity = signal<number>(1.0);

  // Dynamic Live Clock & Freshness State
  readonly liveClock = signal<number>(Date.now());
  readonly liveTimeString = computed(() =>
    new Date(this.liveClock()).toLocaleTimeString('en-IN', {
      hour12: true,
      timeZone: 'Asia/Kolkata'
    })
  );

  // Per-Station Observation Timing & Display Signals
  readonly stationTimings = signal<Map<string, RadarObservationTiming>>(new Map());
  // Stations whose latest image is not a radar sweep (e.g. IMD "under maintenance" placeholder)
  readonly unavailableStations = signal<Set<string>>(new Set());
  readonly lastSyncTime = signal<string | null>(null);
  readonly isRefreshing = signal<boolean>(false);
  readonly allRadarResults = signal<Map<string, ProcessedRadarResult>>(new Map());
  readonly compositeMosaic = signal<ProcessedRadarResult | null>(null);
  readonly hoverInfo = signal<RadarHoverInfo | null>(null);
  readonly centerStationRequest = signal<number>(0);

  // Active Station Timing & Freshness (Independent per-station tracking)
  readonly activeStationTiming = computed<RadarObservationTiming | null>(() => {
    const id = this.activeStationId();
    return this.stationTimings().get(id) || null;
  });

  readonly activeStationAgeMinutes = computed<number | null>(() => {
    const timing = this.activeStationTiming();
    if (!timing?.epochMs) return null;
    return Math.max(0, Math.floor((this.liveClock() - timing.epochMs) / 60000));
  });

  readonly activeStationFreshness = computed<'fresh' | 'recent' | 'stale' | 'offline' | 'syncing'>(() => {
    if (this.unavailableStations().has(this.activeStationId())) return 'offline';
    const age = this.activeStationAgeMinutes();
    if (age === null) return 'syncing';
    if (age <= 60) return 'fresh';
    if (age <= 120) return 'recent';
    if (age <= 180) return 'stale';
    return 'offline';
  });

  readonly observationTiming = this.activeStationTiming;

  readonly displayedStationsCount = computed<number>(() => {
    let count = 0;
    for (const [, res] of this.allRadarResults()) {
      if (res.isDisplayed !== false && res.dataUrl) count++;
    }
    return count;
  });

  private autoRefreshTimer: any = null;
  private liveClockTimer: any = null;
  private currentRequestId = 0;
  private mosaicTimer: ReturnType<typeof setTimeout> | null = null;
  // Last processed sweep per station, keyed by a hash of the GIF bytes. IMD publishes new images
  // roughly every 10 minutes, so most 1-minute refreshes can reuse the previous result.
  private sweepCache = new Map<string, { key: string; result: ProcessedRadarResult | null }>();

  constructor() {
    this.fetchAllRadarSweeps();
    this.startAutoRefresh();
    this.startLiveClock();
  }

  ngOnDestroy(): void {
    if (this.mosaicTimer) {
      clearTimeout(this.mosaicTimer);
      this.mosaicTimer = null;
    }
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
    if (this.liveClockTimer) {
      clearInterval(this.liveClockTimer);
      this.liveClockTimer = null;
    }
  }

  private startAutoRefresh(): void {
    if (typeof window === 'undefined') return;

    this.autoRefreshTimer = setInterval(() => {
      this.fetchAllRadarSweeps();
    }, 60000); // 1-minute auto sync

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.fetchAllRadarSweeps();
      }
    });
  }

  private startLiveClock(): void {
    if (typeof window === 'undefined') return;
    this.liveClockTimer = setInterval(() => {
      this.liveClock.set(Date.now());
      this.checkSweepFreshness();
    }, 1000);
  }

  private checkSweepFreshness(): void {
    const now = this.liveClock();

    // 1. Recalculate dynamic age and freshness categories for each station
    this.stationTimings.update(map => {
      let changed = false;
      const next = new Map(map);
      for (const [stId, timing] of next) {
        if (timing.epochMs) {
          const newAge = Math.max(0, Math.floor((now - timing.epochMs) / 60000));
          if (newAge !== timing.ageMinutes) {
            let freshness: 'fresh' | 'recent' | 'stale' | 'offline' = 'offline';
            if (newAge <= 60) freshness = 'fresh';
            else if (newAge <= 120) freshness = 'recent';
            else if (newAge <= 180) freshness = 'stale';
            else freshness = 'offline';

            next.set(stId, {
              ...timing,
              ageMinutes: newAge,
              freshness
            });
            changed = true;
          }
        }
      }
      return changed ? next : map;
    });

    // 2. Map display gating per radar station (Display if <= 180m / 3h operational window)
    let displayGatingChanged = false;
    this.allRadarResults.update(map => {
      let changed = false;
      const next = new Map(map);
      for (const [stId, res] of next) {
        if (res.timing?.epochMs) {
          const age = (now - res.timing.epochMs) / 60000;
          const shouldDisplay = age <= 180;
          if (res.isDisplayed !== shouldDisplay) {
            next.set(stId, {
              ...res,
              isDisplayed: shouldDisplay
            });
            changed = true;
            displayGatingChanged = true;
            if (!shouldDisplay) {
              console.warn(
                `[RadarService] Station "${stId}" observation is older than 180 mins (${Math.round(age)}m). Hiding layer from map.`
              );
            }
          }
        }
      }
      return changed ? next : map;
    });

    if (displayGatingChanged) {
      this.scheduleMosaic();
    }
  }

  getStationFreshness(stationId: string): 'fresh' | 'recent' | 'stale' | 'offline' | 'syncing' {
    if (this.unavailableStations().has(stationId)) return 'offline';
    const t = this.stationTimings().get(stationId);
    if (!t || t.ageMinutes === undefined) return 'syncing';
    return t.freshness || 'offline';
  }

  getStationAge(stationId: string): number | null {
    const t = this.stationTimings().get(stationId);
    if (!t?.epochMs) return null;
    return Math.max(0, Math.floor((this.liveClock() - t.epochMs) / 60000));
  }

  selectStation(stationId: string): void {
    if (this.activeStationId() === stationId) return;
    this.activeStationId.set(stationId);
    this.requestCenterStation();

    if (!this.allRadarResults().has(stationId)) {
      this.processStationSweep(this.activeStation(), this.activeProduct(), this.transparentMode()).then(res => {
        if (res) {
          this.allRadarResults.update(m => new Map(m).set(stationId, res));
          this.scheduleMosaic();
        }
      });
    }
  }

  setProduct(product: RadarProductKey): void {
    this.activeProduct.set(product);
    this.allRadarResults.set(new Map());
    this.compositeMosaic.set(null);
    this.fetchAllRadarSweeps();
  }

  setTransparent(transparent: boolean): void {
    this.transparentMode.set(transparent);
    this.allRadarResults.set(new Map());
    this.compositeMosaic.set(null);
    this.fetchAllRadarSweeps();
  }

  setRangeRings(show: boolean): void {
    this.showRangeRings.set(show);
  }

  setOpacity(opacity: number): void {
    this.radarOpacity.set(Math.max(0.1, Math.min(1.0, opacity)));
  }

  requestCenterStation(): void {
    this.centerStationRequest.update(v => v + 1);
  }

  async fetchRadarSweep(): Promise<void> {
    await this.fetchAllRadarSweeps();
  }

  async fetchAllRadarSweeps(): Promise<void> {
    const requestId = ++this.currentRequestId;
    this.isRefreshing.set(true);

    const productKey = this.activeProduct();
    const isTransparent = this.transparentMode();

    const queue = [...this.stations];
    const concurrency = 6;

    const worker = async () => {
      while (queue.length > 0) {
        if (requestId !== this.currentRequestId) break;
        const station = queue.shift();
        if (!station) break;
        try {
          const res = await this.processStationSweep(station, productKey, isTransparent);
          if (res && requestId === this.currentRequestId) {
            // Unchanged image: same result object, nothing to redraw
            if (this.allRadarResults().get(station.id) === res) continue;
            this.allRadarResults.update(map => {
              const next = new Map(map);
              next.set(station.id, res);
              return next;
            });
            this.scheduleMosaic();
          } else if (res === null && requestId === this.currentRequestId) {
            this.allRadarResults.update(map => {
              if (map.has(station.id)) {
                const next = new Map(map);
                next.delete(station.id);
                return next;
              }
              return map;
            });
            this.scheduleMosaic();
          }
        } catch {
          // Continue to next station
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (requestId === this.currentRequestId) {
      this.isRefreshing.set(false);
      this.lastSyncTime.set(
        new Date().toLocaleTimeString('en-IN', { hour12: true, timeZone: 'Asia/Kolkata' })
      );
    }
  }

  /**
   * Rebuilding the composite takes a few hundred ms, so station updates arriving close together
   * (one per station on every refresh) are merged into a single rebuild.
   */
  private scheduleMosaic(): void {
    if (this.mosaicTimer) return;
    this.mosaicTimer = setTimeout(() => {
      this.mosaicTimer = null;
      this.generateMergedMosaic();
    }, 150);
  }

  /** FNV-1a hash of the raw image bytes, used to detect unchanged sweeps. */
  private hashBytes(bytes: Uint8Array): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193);
    }
    return `${bytes.length}:${(hash >>> 0).toString(16)}`;
  }

  async processStationSweep(
    station: RadarStationConfig,
    productKey: RadarProductKey,
    isTransparent: boolean
  ): Promise<ProcessedRadarResult | null> {
    const productConfig = station.products[productKey] || station.products.caz;
    const cacheBuster = Date.now();

    const proxies = [
      `/imd-radar/${productConfig.file}`, // Netlify CDN edge proxy (production) & Vite dev proxy (local)
      `/.netlify/functions/radar?file=${productConfig.file}`, // Netlify serverless function fallback
      productConfig.url // Direct fallback
    ];

    let rawArrayBuf: ArrayBuffer | null = null;
    let sweepHeaderDate: Date | null = null;
    let binaryTiming: RadarObservationTiming | null = null;

    for (const url of proxies) {
      try {
        const fetchUrl = `${url}${url.includes('?') ? '&' : '?'}_t=${cacheBuster}`;
        const response = await fetch(fetchUrl);
        if (response && response.ok) {
          const buf = await response.arrayBuffer();
          if (buf && buf.byteLength > 1000) {
            const bytes = new Uint8Array(buf);
            // Verify binary GIF magic header 'GIF87a' or 'GIF89a' (ASCII 0x47, 0x49, 0x46)
            if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
              rawArrayBuf = buf;
              binaryTiming = this.extractRadarIsoTimestamp(buf);
              const lastMod = response.headers.get('last-modified') || response.headers.get('date');
              if (lastMod) {
                sweepHeaderDate = new Date(lastMod);
              }
              break;
            }
          }
        }
      } catch {
        // Fallback to next proxy
      }
    }

    if (!rawArrayBuf) return null;

    // ── Observation Timestamp Extraction & Per-Station Freshness Calculation ──
    let timing: RadarObservationTiming | null = binaryTiming;
    if (!timing && sweepHeaderDate && !isNaN(sweepHeaderDate.getTime())) {
      const istTime = sweepHeaderDate.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: 'Asia/Kolkata'
      }) + ' IST';
      const utcTime = sweepHeaderDate.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'UTC'
      }) + ' UTC';
      const istDate = sweepHeaderDate.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Asia/Kolkata'
      }).replace(/\//g, '-');
      timing = {
        ist: istTime,
        utc: utcTime,
        date: istDate,
        raw: sweepHeaderDate.toISOString(),
        epochMs: sweepHeaderDate.getTime(),
        source: 'http_header'
      };
      // Upload time, not the scan time printed on the image: mark it as approximate
      timing.ist = `~${timing.ist}`;
      timing.utc = `~${timing.utc}`;
    }

    const now = Date.now();
    let ageMinutes: number | undefined;
    let freshness: 'fresh' | 'recent' | 'stale' | 'offline' = 'offline';
    let isDisplayed = true;

    if (timing?.epochMs && !isNaN(timing.epochMs)) {
      ageMinutes = Math.max(0, Math.floor((now - timing.epochMs) / 60000));
      if (ageMinutes <= 60) freshness = 'fresh';
      else if (ageMinutes <= 120) freshness = 'recent';
      else if (ageMinutes <= 180) freshness = 'stale';
      else freshness = 'offline';

      // Radar is displayed on the map if observation is within the operational window (<= 180 mins / 3 hours)
      isDisplayed = ageMinutes <= 180;
    }

    if (timing) {
      timing.ageMinutes = ageMinutes;
      timing.freshness = freshness;
      this.stationTimings.update(m => new Map(m).set(station.id, timing!));
    }

    // Skip decoding only if radar sweep is older than 24 hours (1440 mins) or unreadable
    if (ageMinutes !== undefined && ageMinutes > 1440) {
      console.warn(
        `[RadarService] Skipping station "${station.name}": Sweep is ${Math.round(ageMinutes)} mins old (> 24 hours). Offline.`
      );
      return null;
    }

    // Same image as last time: reuse the processed result instead of decoding it again
    const cacheKey = `${productKey}|${isTransparent}|${this.hashBytes(new Uint8Array(rawArrayBuf))}`;
    const cached = this.sweepCache.get(station.id);
    if (cached && cached.key === cacheKey) {
      if (!cached.result || cached.result.isDisplayed === isDisplayed) return cached.result;
      const updated = { ...cached.result, isDisplayed, timing };
      this.sweepCache.set(station.id, { key: cacheKey, result: updated });
      return updated;
    }
    const processed = await this.decodeAndProcessSweep(station, productKey, productConfig, isTransparent, rawArrayBuf, timing, isDisplayed);
    this.sweepCache.set(station.id, { key: cacheKey, result: processed });
    return processed;
  }

  private async decodeAndProcessSweep(
    station: RadarStationConfig,
    productKey: RadarProductKey,
    productConfig: RadarStationConfig['products'][RadarProductKey],
    isTransparent: boolean,
    rawArrayBuf: ArrayBuffer,
    timing: RadarObservationTiming | null,
    isDisplayed: boolean
  ): Promise<ProcessedRadarResult | null> {
    let w = 0;
    let h = 0;
    let rgba: Uint8ClampedArray | Uint8Array | null = null;

    if (rawArrayBuf) {
      try {
        const reader = new GifReader(new Uint8Array(rawArrayBuf));
        w = reader.width;
        h = reader.height;
        const numFrames = reader.numFrames();
        const frameIdx = Math.max(0, numFrames - 1);
        const decoded = new Uint8Array(w * h * 4);
        reader.decodeAndBlitFrameRGBA(frameIdx, decoded);
        rgba = decoded;
      } catch (gifErr) {
        console.warn('omggif decode error, attempting canvas fallback:', gifErr);
      }
    }

    // Fallback: HTMLImageElement via Blob
    if (!rgba && rawArrayBuf) {
      try {
        const blob = new Blob([rawArrayBuf], { type: 'image/gif' });
        const blobUrl = URL.createObjectURL(blob);
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = (e) => reject(e);
          img.src = blobUrl;
        });

        w = img.naturalWidth || img.width;
        h = img.naturalHeight || img.height;
        const rawCanvas = document.createElement('canvas');
        rawCanvas.width = w;
        rawCanvas.height = h;
        const rawCtx = rawCanvas.getContext('2d', { willReadFrequently: true });
        if (rawCtx) {
          rawCtx.drawImage(img, 0, 0);
          rgba = rawCtx.getImageData(0, 0, w, h).data;
        }
        URL.revokeObjectURL(blobUrl);
      } catch (fallbackErr) {
        console.warn('Canvas GIF fallback error:', fallbackErr);
      }
    }

    if (!rgba || w < 50 || h < 50) {
      return null;
    }

    // Layout check: if the image no longer matches the configured crop it is not a radar sweep
    // (IMD swaps in an "under maintenance" photo) or the product layout has changed. Decoding it
    // anyway would paint photo pixels as fake echoes.
    const crop = productConfig.crop;
    const layoutMatches = !crop || (crop.x + crop.w <= w + 2 && crop.y + crop.h <= h + 2);
    this.setStationUnavailable(station.id, !layoutMatches);
    if (!layoutMatches) {
      console.warn(
        `[RadarService] Station "${station.name}" ${productKey.toUpperCase()} image is ${w}x${h}, ` +
        `which does not match its configured layout. Treating station as offline.`
      );
      return null;
    }

    // 1. Full Square Extent Crop Detection (Preserves all corner storm echoes)
    let cropX = 0;
    let cropY = 0;
    let cropW = w;
    let cropH = h;

    if (productConfig.crop) {
      cropX = productConfig.crop.x;
      cropY = productConfig.crop.y;
      cropW = productConfig.crop.w;
      cropH = productConfig.crop.h;
    } else if (w > h) {
      cropX = 0;
      cropY = 0;
      cropW = h;
      cropH = h;
    } else {
      cropX = 0;
      cropY = 0;
      cropW = w;
      cropH = h;
    }

    // 2. High-Resolution Square Output Canvas (1024x1024 for smooth curved contours at deep zoom)
    const outSize = 1024;
    const halfSize = outSize / 2;
    const maxRadius = halfSize - 2; // Strict circular radar sweep boundary limit
    const outCanvas = document.createElement('canvas');
    outCanvas.width = outSize;
    outCanvas.height = outSize;
    const outCtx = outCanvas.getContext('2d')!;
    const outImgData = outCtx.createImageData(outSize, outSize);
    const outData = outImgData.data;

    const rawGrid = new Float32Array(outSize * outSize);
    let hasAnyEcho = false;
    const isXBand = station.band === 'X-Band';

    // 3. Sample from source image strictly within the circular radar sweep dish
    for (let outY = 0; outY < outSize; outY++) {
      const dy = outY - halfSize;
      const rowOffset = outY * outSize;
      const normY = outY / (outSize - 1);
      const srcY = Math.round(cropY + normY * (cropH - 1));

      for (let outX = 0; outX < outSize; outX++) {
        const dx = outX - halfSize;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Circular Dish Mask: completely clip anything outside radar sweep circle
        if (dist > maxRadius) continue;

        const normX = outX / (outSize - 1);
        const srcX = Math.round(cropX + normX * (cropW - 1));

        if (srcX < 0 || srcX >= w || srcY < 0 || srcY >= h) continue;

        const srcIdx = (srcY * w + srcX) * 4;
        const r = rgba[srcIdx];
        const g = rgba[srcIdx + 1];
        const b = rgba[srcIdx + 2];

        const rainVal = this.classifyRainPixel(r, g, b, isTransparent, isXBand, productConfig.palette);
        if (rainVal > 0) {
          rawGrid[rowOffset + outX] = rainVal;
          hasAnyEcho = true;
        }
      }
    }

    const finalField = new Float32Array(outSize * outSize);

    if (isTransparent && hasAnyEcho) {
      // 3.5. Meteorological Spatial Coherence & Clutter Suppression Filter:
      // Meteorological rain cells form spatially coherent 2D precipitation clouds.
      // High-gain receiver noise, clear-air boundary layer backscatter, sea clutter, and
      // radar transmitter artifacts produce isolated 1-to-4 pixel specks (such as Chennai S-Band's
      // concentric ring clutter at 150-250km).
      const visited = new Uint8Array(outSize * outSize);
      const queue = new Int32Array(outSize * outSize);
      const compIndices = new Int32Array(outSize * outSize);

      for (let y = 0; y < outSize; y++) {
        const rowOffset = y * outSize;
        for (let x = 0; x < outSize; x++) {
          const startIdx = rowOffset + x;
          if (rawGrid[startIdx] <= 0 || visited[startIdx] === 1) continue;

          let head = 0;
          let tail = 0;
          let compCount = 0;
          let maxVal = 0.0;

          queue[tail++] = startIdx;
          visited[startIdx] = 1;

          while (head < tail) {
            const curr = queue[head++];
            compIndices[compCount++] = curr;
            const v = rawGrid[curr];
            if (v > maxVal) maxVal = v;

            const cy = Math.floor(curr / outSize);
            const cx = curr % outSize;

            for (let dy = -1; dy <= 1; dy++) {
              const ny = cy + dy;
              if (ny < 0 || ny >= outSize) continue;
              const nRow = ny * outSize;
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = cx + dx;
                if (nx < 0 || nx >= outSize) continue;
                const nIdx = nRow + nx;
                if (rawGrid[nIdx] > 0 && visited[nIdx] === 0) {
                  visited[nIdx] = 1;
                  queue[tail++] = nIdx;
                }
              }
            }
          }

          // Meteorological Spatial Coherence Rules:
          // A detected echo is considered genuine precipitation only if:
          // 1. It forms an extensive contiguous rain area (>= 60 pixels in the 1024x1024 grid, representing ~15 sq km)
          // 2. OR it contains an active convective core (maxVal >= 1.4, i.e. >= 25 dBZ) with at least 15 pixels area
          const isCoherentRain = compCount >= 60 || (maxVal >= 1.4 && compCount >= 15);
          if (!isCoherentRain) {
            for (let i = 0; i < compCount; i++) {
              rawGrid[compIndices[i]] = 0.0;
            }
          }
        }
      }

      removeRadialInterference(rawGrid, outSize);

      // Re-evaluate hasAnyEcho after clutter filtering
      hasAnyEcho = false;
      for (let i = 0; i < rawGrid.length; i++) {
        if (rawGrid[i] > 0) {
          hasAnyEcho = true;
          break;
        }
      }
    }

    if (isTransparent && hasAnyEcho) {
      // 4. Organic Contour Curvature & Smooth Border Blending
      // - Gentle radius-1.5 circular filter connects discrete pixel blocks into continuous lobes
      const dilatedGrid = new Float32Array(outSize * outSize);
      for (let y = 0; y < outSize; y++) {
        const rowOffset = y * outSize;
        for (let x = 0; x < outSize; x++) {
          let maxVal = rawGrid[rowOffset + x];
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= outSize) continue;
            const nRow = ny * outSize;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= outSize) continue;
              const v = rawGrid[nRow + nx];
              if (v > maxVal) maxVal = v;
            }
          }
          dilatedGrid[rowOffset + x] = maxVal;
        }
      }

      // - 2-Pass Separable Gaussian Blur (radius 3) rounds out 90-degree corners into smooth curved arcs
      const kernel = [0.05, 0.12, 0.22, 0.22, 0.22, 0.12, 0.05];
      const kRadius = 3;
      const tempGrid = new Float32Array(outSize * outSize);
      const blurredGrid = new Float32Array(outSize * outSize);

      // Horizontal pass
      for (let y = 0; y < outSize; y++) {
        const rowOffset = y * outSize;
        for (let x = 0; x < outSize; x++) {
          let sum = 0;
          for (let k = -kRadius; k <= kRadius; k++) {
            const nx = Math.min(outSize - 1, Math.max(0, x + k));
            sum += dilatedGrid[rowOffset + nx] * kernel[k + kRadius];
          }
          tempGrid[rowOffset + x] = sum;
        }
      }

      // Vertical pass
      for (let y = 0; y < outSize; y++) {
        for (let x = 0; x < outSize; x++) {
          let sum = 0;
          for (let k = -kRadius; k <= kRadius; k++) {
            const ny = Math.min(outSize - 1, Math.max(0, y + k));
            sum += tempGrid[ny * outSize + x] * kernel[k + kRadius];
          }
          blurredGrid[y * outSize + x] = sum;
        }
      }

      // - Color mapping with smooth Hermite border feathering (blends seamlessly into terrain)
      for (let y = 0; y < outSize; y++) {
        const dy = y - halfSize;
        const rowOffset = y * outSize;
        for (let x = 0; x < outSize; x++) {
          const dx = x - halfSize;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const dishEdgeDist = maxRadius - dist;
          if (dishEdgeDist <= 0) continue;

          let val = blurredGrid[rowOffset + x];

          // Preserve authentic peak core intensity (Red, Orange, Yellow, Purple)
          const rawVal = rawGrid[rowOffset + x];
          if (rawVal >= 2.0 && rawVal > val) {
            val = rawVal * 0.85 + val * 0.15;
          }

          if (dishEdgeDist < 8) {
            val *= Math.max(0, dishEdgeDist / 8);
          }

          finalField[rowOffset + x] = val;

          if (val >= 0.06) {
            // Smooth border blend (alpha feathering from 0.06 to 0.32)
            let borderBlend = 1.0;
            if (val < 0.32) {
              const t = Math.max(0, Math.min(1, (val - 0.06) / (0.32 - 0.06)));
              borderBlend = t * t * (3 - 2 * t);
            }

            let edgeAlpha = 1.0;
            const edgeDist = Math.min(x, y, outSize - 1 - x, outSize - 1 - y, dishEdgeDist);
            if (edgeDist < 4) {
              edgeAlpha = Math.max(0, edgeDist / 4.0);
            }

            const [r, g, b, a] = sampleRadarColorRamp(val);
            const pIdx = (rowOffset + x) * 4;
            outData[pIdx] = r;
            outData[pIdx + 1] = g;
            outData[pIdx + 2] = b;
            outData[pIdx + 3] = Math.round(a * borderBlend * edgeAlpha);
          }
        }
      }
    } else if (!isTransparent) {
      // Raw Mode: copy raw pixels strictly within circular dish
      for (let y = 0; y < outSize; y++) {
        const dy = y - halfSize;
        const rowOffset = y * outSize;
        const normY = y / (outSize - 1);
        const srcY = Math.round(cropY + normY * (cropH - 1));

        for (let x = 0; x < outSize; x++) {
          const dx = x - halfSize;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > maxRadius) continue;

          const normX = x / (outSize - 1);
          const srcX = Math.round(cropX + normX * (cropW - 1));
          if (srcX < 0 || srcX >= w || srcY < 0 || srcY >= h) continue;

          const srcIdx = (srcY * w + srcX) * 4;
          const pIdx = (rowOffset + x) * 4;
          outData[pIdx] = rgba[srcIdx];
          outData[pIdx + 1] = rgba[srcIdx + 1];
          outData[pIdx + 2] = rgba[srcIdx + 2];
          outData[pIdx + 3] = 255;
          finalField[rowOffset + x] = 1.0;
        }
      }
    }

    outCtx.putImageData(outImgData, 0, 0);
    const dataUrl = outCanvas.toDataURL('image/png');

    const fieldDataRecord: RadarFieldData = {
      field: finalField,
      cropW: outSize,
      cropH: outSize,
      cx: outSize / 2,
      cy: outSize / 2,
      radius: outSize / 2,
      bounds: productConfig.bounds
    };

    const result: ProcessedRadarResult = {
      stationId: station.id,
      dataUrl,
      fieldData: fieldDataRecord,
      timing,
      coordinates: productConfig.maplibreCoordinates,
      isDisplayed
    };

    return result;
  }

  /**
   * Generates a single unified composite radar mosaic across all active stations.
   * Where multiple radars overlap (e.g. Karaikal and Kochi), their rain intensity
   * fields are merged seamlessly before color mapping, preserving peak storm cores
   * and smoothly blending contours, completely eliminating overlapping layer seams.
   */
  generateMergedMosaic(): ProcessedRadarResult | null {
    if (typeof document === 'undefined') return null;

    const allResults = this.allRadarResults();
    const activeStations: {
      station: RadarStationConfig;
      res: ProcessedRadarResult;
      south: number;
      west: number;
      north: number;
      east: number;
      cropW: number;
      cropH: number;
      field: Float32Array;
      cosLat: number;
    }[] = [];

    let latestTiming: RadarObservationTiming | null = null;

    for (const [stId, res] of allResults) {
      if (!res.dataUrl || res.isDisplayed === false || !res.fieldData) continue;
      const st = this.stations.find(s => s.id === stId);
      if (!st) continue;

      const b = res.fieldData.bounds;
      activeStations.push({
        station: st,
        res,
        south: b[0][0],
        west: b[0][1],
        north: b[1][0],
        east: b[1][1],
        cropW: res.fieldData.cropW,
        cropH: res.fieldData.cropH,
        field: res.fieldData.field,
        cosLat: Math.cos((st.lat * Math.PI) / 180)
      });

      if (res.timing && (!latestTiming || (res.timing.epochMs && (!latestTiming.epochMs || res.timing.epochMs > latestTiming.epochMs)))) {
        latestTiming = res.timing;
      }
    }

    if (activeStations.length === 0) {
      this.compositeMosaic.set(null);
      return null;
    }

    // 1. Calculate combined bounding box of all active stations
    let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
    for (const s of activeStations) {
      if (s.west < minLng) minLng = s.west;
      if (s.east > maxLng) maxLng = s.east;
      if (s.south < minLat) minLat = s.south;
      if (s.north > maxLat) maxLat = s.north;
    }

    // 2. Determine composite canvas resolution (~600m - 750m per pixel)
    const midLat = (minLat + maxLat) / 2;
    const cosMidLat = Math.cos((midLat * Math.PI) / 180);
    const dLngKm = (maxLng - minLng) * 111.32 * cosMidLat;
    const dLatKm = (maxLat - minLat) * 111.32;

    const outW = Math.min(1600, Math.max(1024, Math.round(1024 * (dLngKm / 510))));
    const outH = Math.min(1600, Math.max(1024, Math.round(1024 * (dLatKm / 510))));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const imgData = ctx.createImageData(outW, outH);
    const data = imgData.data;
    const compositeField = new Float32Array(outW * outH);

    // 3. Composite pixel loop
    const lngSpan = maxLng - minLng;
    const latSpan = maxLat - minLat;

    for (let y = 0; y < outH; y++) {
      const rowOffset = y * outW;
      const lat = maxLat - (y / (outH - 1)) * latSpan;

      for (let x = 0; x < outW; x++) {
        const lng = minLng + (x / (outW - 1)) * lngSpan;

        let maxVal = 0;
        let weightedSum = 0;
        let totalWeight = 0;
        let activeCount = 0;

        for (let i = 0; i < activeStations.length; i++) {
          const s = activeStations[i];
          if (lat < s.south || lat > s.north || lng < s.west || lng > s.east) continue;

          // Check distance to station center
          const dLat = (lat - s.station.lat) * 111.32;
          const dLng = (lng - s.station.lng) * 111.32 * s.cosLat;
          const distKm = Math.hypot(dLat, dLng);
          if (distKm > s.station.operationalRangeKm) continue;

          // Normalized coordinates in station crop
          const u = (lng - s.west) / (s.east - s.west);
          const v = (s.north - lat) / (s.north - s.south);
          const fx = u * (s.cropW - 1);
          const fy = v * (s.cropH - 1);

          const cx = s.cropW / 2;
          const cy = s.cropH / 2;
          const cDist = Math.hypot(fx - cx, fy - cy);
          if (cDist > cx - 2) continue;

          // Bilinear sample from station field
          const x0 = Math.floor(fx);
          const x1 = Math.min(x0 + 1, s.cropW - 1);
          const y0 = Math.floor(fy);
          const y1 = Math.min(y0 + 1, s.cropH - 1);
          const wx = fx - x0;
          const wy = fy - y0;

          const f = s.field;
          const s00 = f[y0 * s.cropW + x0];
          const s10 = f[y0 * s.cropW + x1];
          const s01 = f[y1 * s.cropW + x0];
          const s11 = f[y1 * s.cropW + x1];

          let val = (s00 * (1 - wx) + s10 * wx) * (1 - wy) + (s01 * (1 - wx) + s11 * wx) * wy;

          // Smooth dish edge feathering so range boundaries never show seams
          const dishEdgeDist = (cx - 2) - cDist;
          if (dishEdgeDist < 8) {
            val *= Math.max(0, dishEdgeDist / 8);
          }

          if (val > 0) {
            if (val > maxVal) maxVal = val;
            const w = Math.max(0.1, 1 - distKm / s.station.operationalRangeKm);
            weightedSum += val * w;
            totalWeight += w;
            activeCount++;
          }
        }

        if (activeCount === 0) continue;

        let mergedVal = maxVal;
        if (activeCount > 1) {
          // Merge overlapping radars: preserve peak storm core while smoothly blending surrounding contours
          const avgVal = totalWeight > 0 ? weightedSum / totalWeight : maxVal;
          mergedVal = 0.80 * maxVal + 0.20 * avgVal;
        }

        compositeField[rowOffset + x] = mergedVal;

        if (mergedVal >= 0.06) {
          // Smooth Hermite border blend
          let borderBlend = 1.0;
          if (mergedVal < 0.32) {
            const t = Math.max(0, Math.min(1, (mergedVal - 0.06) / (0.32 - 0.06)));
            borderBlend = t * t * (3 - 2 * t);
          }

          const [r, g, b, a] = sampleRadarColorRamp(mergedVal);
          const pIdx = (rowOffset + x) * 4;
          data[pIdx] = r;
          data[pIdx + 1] = g;
          data[pIdx + 2] = b;
          data[pIdx + 3] = Math.round(a * borderBlend);
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');

    const result: ProcessedRadarResult = {
      stationId: 'composite-mosaic',
      dataUrl,
      coordinates: [
        [minLng, maxLat], // NW
        [maxLng, maxLat], // NE
        [maxLng, minLat], // SE
        [minLng, minLat]  // SW
      ],
      fieldData: {
        field: compositeField,
        cropW: outW,
        cropH: outH,
        cx: outW / 2,
        cy: outH / 2,
        radius: Math.hypot(outW, outH) / 2,
        bounds: [[minLat, minLng], [maxLat, maxLng]]
      },
      timing: latestTiming,
      isDisplayed: true
    };

    this.compositeMosaic.set(result);
    return result;
  }

  private setStationUnavailable(stationId: string, unavailable: boolean): void {
    this.unavailableStations.update(set => {
      if (set.has(stationId) === unavailable) return set;
      const next = new Set(set);
      if (unavailable) next.add(stationId);
      else next.delete(stationId);
      return next;
    });
  }

  /**
   * Matches a pixel against a station's exact legend colours (GIF palettes are lossless, so a small
   * tolerance only absorbs encoder rounding). Returns the field value on the shared intensity scale
   * (dBZ = 12 + value * 9.6), or 0 for anything that is not an echo colour.
   */
  private classifyPalettePixel(r: number, g: number, b: number, palette: RadarPaletteEntry[]): number {
    const tolerance = 6;
    for (const entry of palette) {
      const [pr, pg, pb] = entry.rgb;
      if (Math.abs(r - pr) <= tolerance && Math.abs(g - pg) <= tolerance && Math.abs(b - pb) <= tolerance) {
        // Echoes below ~8 dBZ are clear-air returns / noise rather than precipitation
        if (entry.dbz < 8) return 0.0;
        return Math.max(0.3, (entry.dbz - 12) / 9.6);
      }
    }
    return 0.0;
  }

  private classifyRainPixel(
    r: number,
    g: number,
    b: number,
    isTransparent: boolean,
    isXBand = false,
    palette?: RadarPaletteEntry[]
  ): number {
    if (!isTransparent) return 1.0;
    if (palette) return this.classifyPalettePixel(r, g, b, palette);

    const maxRGB = Math.max(r, g, b);
    const minRGB = Math.min(r, g, b);
    const diff = maxRGB - minRGB;

    // 1. Black/Dark borders, grids, text, noise
    if (maxRGB <= 45) return 0.0;

    // 2. Pure grayscale / white paper canvas / monochromatic grid lines (diff <= 8)
    // Rejects pure white [255,255,255] (diff=0), grey sea [211,211,211], range rings [243,243,242] (diff=1)
    if (diff <= 8) return 0.0;

    // 3. Rejects pure green administrative district boundaries & state borders (Chennai DWR)
    // IMD draws district lines in pure green rgb(0, 255, 0) / rgb(0, 204, 0)
    if (r <= 35 && g >= 160 && b <= 60) return 0.0;

    // 4. Sea & Grayscale features (diff <= 25, e.g. grey sea background 191,191,191 and 134,134,134)
    if (diff <= 25) return 0.0;

    // 5. Chennai Sea & Land Background:
    // In Chennai DWR, IMD colors the Bay of Bengal sea in cyan/blue tones where b >= 140 and r >= 65
    // [102, 204, 255], [153, 204, 255], [102, 153, 255], [102, 153, 204], [153, 153, 255]
    // Authentic IMD blue/cyan rain echoes always have low red (r <= 50).
    if (b >= 140 && r >= 65) return 0.0;

    // 6. Mountain terrain / elevation relief (Western Ghats warm tan/beige/khaki)
    // Topographic shading has warm tan/brown tints with high red/green and low-medium blue
    if (r >= 160 && g >= 140 && b >= 90 && r >= b) return 0.0;

    // 7. Purple (Severe storm core / Hail > 55 dBZ)
    if (r >= 180 && b >= 140 && g <= 100) return 5.2;

    // 8. Red (Torrential Rain 48 - 55 dBZ)
    // Covers Karaikal (255,0,0), Chennai (204,0,0), (153,0,0), (255,51,0), Kochi (250,2,2), (231,13,7), (211,21,3)
    if ((r >= 180 && g <= 80 && b <= 80) || (r >= 150 && g <= 50 && b <= 50)) return 4.4;

    // 9. Orange & Red-Orange (40 - 48 dBZ)
    // Covers Karaikal (255,134,0), (255,97,0), Chennai (255,102,0), (255,153,0), Kochi (250,148,7), (245,147,14), (231,165,2), (234,165,12), (218,170,4)
    if (r >= 210 && b <= 50 && g <= 180) {
      return g <= 155 ? 3.8 : 3.4;
    }

    // 10. Yellow (34 - 40 dBZ)
    // Covers Karaikal (255,236,68), Chennai (255,204,0), (255,255,0), Kochi (244,242,79), (251,248,23), (253,253,3)
    if (r >= 210 && g >= 190 && b <= 90) return 3.0;

    // 11. Green Rain (S-Band / PPI / SRI)
    if (!isXBand && g >= 165 && r <= 50 && b <= 120) return 2.0;

    // 12. Cyan / Sky Blue Rain Echoes -> Light Blue (18 - 26 dBZ)
    if (b >= 180 && g >= 120 && r <= 70) return 1.4;

    // 13. Deep Blue / Royal Blue (14 - 18 dBZ)
    if (b >= 150 && r <= 50 && g <= 120) return 1.0;

    // 14. Dark Purple / Indigo (Light Echo 10 - 14 dBZ)
    if (b >= 120 && r <= 70 && g <= 50) return 0.7;

    // Reject all remaining terrain, elevation DEM tints, lake/coast borders
    return 0.0;
  }

  // 📡 Real-time dBZ Hover Inspector across all active radars in India
  inspectLocation(lat: number, lng: number, screenPoint: { x: number; y: number }): void {
    let maxV = 0.0;
    let bestStation: RadarStationConfig | null = null;

    const mosaic = this.compositeMosaic();
    if (mosaic && mosaic.fieldData) {
      const { field, cropW, cropH, bounds } = mosaic.fieldData;
      const [southWest, northEast] = bounds;
      const minLat = southWest[0];
      const minLng = southWest[1];
      const maxLat = northEast[0];
      const maxLng = northEast[1];

      if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) {
        const normY = (maxLat - lat) / (maxLat - minLat);
        const normX = (lng - minLng) / (maxLng - minLng);
        const srcX = normX * (cropW - 1);
        const srcY = normY * (cropH - 1);

        if (srcX >= 0 && srcX < cropW && srcY >= 0 && srcY < cropH) {
          const x0 = Math.floor(srcX);
          const x1 = Math.min(x0 + 1, cropW - 1);
          const y0 = Math.floor(srcY);
          const y1 = Math.min(y0 + 1, cropH - 1);
          const wx = srcX - x0;
          const wy = srcY - y0;

          const s00 = field[y0 * cropW + x0];
          const s10 = field[y0 * cropW + x1];
          const s01 = field[y1 * cropW + x0];
          const s11 = field[y1 * cropW + x1];
          maxV = (s00 * (1 - wx) + s10 * wx) * (1 - wy) + (s01 * (1 - wx) + s11 * wx) * wy;

          // Find closest active station for name attribution
          let minD = Infinity;
          for (const s of this.stations) {
            const d = Math.hypot((lat - s.lat) * 111.32, (lng - s.lng) * 111.32 * Math.cos((s.lat * Math.PI) / 180));
            if (d < minD) {
              minD = d;
              bestStation = s;
            }
          }
        }
      }
    } else {
      const all = this.allRadarResults();
      if (all.size === 0) {
        this.hoverInfo.set(null);
        return;
      }

      for (const [stationId, res] of all) {
        if (res.isDisplayed === false || !res.fieldData) continue;
        const { field, cropW, cropH, bounds, cx, cy, radius } = res.fieldData;
        const [southWest, northEast] = bounds;
        const minLat = southWest[0];
        const minLng = southWest[1];
        const maxLat = northEast[0];
        const maxLng = northEast[1];

        if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) continue;

        const normY = (maxLat - lat) / (maxLat - minLat);
        const normX = (lng - minLng) / (maxLng - minLng);
        const srcX = normX * (cropW - 1);
        const srcY = normY * (cropH - 1);

        if (srcX < 0 || srcX >= cropW || srcY < 0 || srcY >= cropH) continue;
        const dx = srcX - cx;
        const dy = srcY - cy;
        if (dx * dx + dy * dy > (radius - 2) * (radius - 2)) continue;

        const x0 = Math.floor(srcX);
        const x1 = Math.min(x0 + 1, cropW - 1);
        const y0 = Math.floor(srcY);
        const y1 = Math.min(y0 + 1, cropH - 1);
        const wx = srcX - x0;
        const wy = srcY - y0;

        const s00 = field[y0 * cropW + x0];
        const s10 = field[y0 * cropW + x1];
        const s01 = field[y1 * cropW + x0];
        const s11 = field[y1 * cropW + x1];
        const v = (s00 * (1 - wx) + s10 * wx) * (1 - wy) + (s01 * (1 - wx) + s11 * wx) * wy;

        if (v > maxV) {
          maxV = v;
          bestStation = this.stations.find(s => s.id === stationId) || null;
        }
      }
    }

    if (maxV >= 0.15 && bestStation) {
      const dbz = Math.min(65, Math.max(12, Math.round(12 + maxV * 9.6)));
      let label = 'Light Rain';
      let color = '#0ea5e9'; // Blue
      let rate = '0.5 – 2.5 mm/h';

      if (dbz >= 55) {
        label = 'Severe Storm / Hail';
        color = '#a855f7'; // Purple
        rate = '> 50 mm/h';
      } else if (dbz >= 45) {
        label = 'Torrential Rain';
        color = '#ef4444'; // Red
        rate = '30 – 50 mm/h';
      } else if (dbz >= 36) {
        label = 'Heavy Rain';
        color = '#facc15'; // Yellow
        rate = '10 – 30 mm/h';
      } else if (dbz >= 26) {
        label = 'Moderate Rain';
        color = '#22c55e'; // Green
        rate = '2.5 – 10 mm/h';
      } else if (dbz >= 18) {
        label = 'Light Rain';
        color = '#0ea5e9'; // Sky Blue
        rate = '1.0 – 2.5 mm/h';
      } else {
        label = 'Light Echo';
        color = '#2563eb'; // Deep Blue
        rate = '< 1.0 mm/h';
      }

      this.hoverInfo.set({
        x: screenPoint.x,
        y: screenPoint.y,
        lat,
        lng,
        dbz,
        label: `${label} (${dbz} dBZ)`,
        color,
        rate
      });
    } else {
      this.hoverInfo.set(null);
    }
  }

  clearHover(): void {
    this.hoverInfo.set(null);
  }

  private extractRadarIsoTimestamp(arrayBuffer: ArrayBuffer): RadarObservationTiming | null {
    try {
      const bytes = new Uint8Array(arrayBuffer);
      // Scan for all embedded ISO timestamps (e.g. "2026-09-29T22:12:22")
      // In animated GIFs, multiple timestamps exist across frames; pick the latest one (maximum epochMs)
      let str = '';
      const step = Math.max(1, Math.floor(bytes.length / 50000));
      for (let i = 0; i < bytes.length; i += step) {
        str += String.fromCharCode(bytes[i]);
      }
      const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
      const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 65536)));
      const fullText = head + ' ' + str + ' ' + tail;

      const regex = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/g;
      const matches = [...fullText.matchAll(regex)];
      if (matches.length === 0) return null;

      let bestMatch = matches[0];
      let maxEpoch = 0;

      for (const m of matches) {
        const epoch = new Date(`${m[0]}+05:30`).getTime();
        if (!isNaN(epoch) && epoch > maxEpoch) {
          maxEpoch = epoch;
          bestMatch = m;
        }
      }

      const [full, yyyy, mm, dd, hh, min, ss] = bestMatch;
      const h = parseInt(hh, 10);
      const m = parseInt(min, 10);
      const s = parseInt(ss, 10);
      const h12 = h % 12 || 12;
      const ampm = h >= 12 ? 'PM' : 'AM';
      const pad = (n: number) => String(n).padStart(2, '0');
      const istTime = `${pad(h12)}:${pad(m)}:${pad(s)} ${ampm} IST`;

      let totalMin = h * 60 + m - 330;
      if (totalMin < 0) totalMin += 1440;
      const utcH = Math.floor(totalMin / 60) % 24;
      const utcM = totalMin % 60;
      const utcTime = `${pad(utcH)}:${pad(utcM)}:${pad(s)} UTC`;
      const dateStr = `${dd}-${mm}-${yyyy}`;

      const sweepEpoch = new Date(`${full}+05:30`).getTime();
      const epochMs = maxEpoch > 0 ? maxEpoch : (!isNaN(sweepEpoch) ? sweepEpoch : undefined);

      return { ist: istTime, utc: utcTime, date: dateStr, raw: full, epochMs, source: 'radar_metadata' };
    } catch {
      // Ignore
    }
    return null;
  }
}
