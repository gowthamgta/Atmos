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

import { blurSeparable, dequantizeRadar, gaussianKernel, quantizeRadarField, resampleBilinear } from './radar-field';
import { animationFile, gifFrameTimestamps, historySlots, recentFrames, scanForSlot } from './radar-history';
import { TrackingGrid, sampleToGrid, trackingGrid } from './storm-tracking';
import { isPhone, radarMosaicMaxPx } from '../ui/device-profile';
import { MERGED_PRODUCTS, MOSAIC_KM_PER_PX, composeRadarMosaic } from './radar-mosaic';

/** What the map shows for the radar: the mosaic's intensity (one byte per pixel) placed by its corners, and its time. */
export interface RadarDisplayFrame {
  field: Uint8Array;
  width: number;
  height: number;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  timeMs: number | null;
}

/** One step of the one-hour loop: its picture and the intensity on the ~4 km storm-tracking grid. */
export interface RadarHistoryFrame extends RadarDisplayFrame {
  timeMs: number;
  track: Float32Array;
}

const yieldToBrowser = () => new Promise<void>(r => setTimeout(r, 0));

export { RADAR_COLOR_STOPS, sampleRadarColorRamp } from './radar-field';

export { MERGED_PRODUCTS } from './radar-mosaic';

/**
 * Blur applied to the reconstructed intensity, in pixels of the 1024 grid (about 0.5 km each). Light: the GPU layer
 * smooths the intensity itself when it draws, so contours stay crisp at any zoom.
 */
const RADAR_BLUR_SIGMA_PX = 1.5;

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
  /** The merged scans other than CAZ (PPI, SRI), keyed `stationId:product`. CAZ stays in allRadarResults. */
  private readonly extraResults = signal<Map<string, ProcessedRadarResult>>(new Map());
  readonly compositeMosaic = signal<ProcessedRadarResult | null>(null);
  readonly hoverInfo = signal<RadarHoverInfo | null>(null);

  // ── One-hour loop (from IMD's animated GIFs) ──
  readonly history = signal<RadarHistoryFrame[]>([]);
  readonly historyLoading = signal(false);
  /** 0..1 while the loop is being built. */
  readonly historyProgress = signal(0);
  /** Loop position: an index into `history`, or null for the live picture. */
  readonly playIndex = signal<number | null>(null);
  readonly playing = signal(false);
  /** IMD publishes animations for the max-reflectivity (CAZ) and rain-rate (SRI) products only. */
  readonly historyAvailable = computed(() => animationFile('x', this.activeProduct()) !== null);
  /** The picture on the map: the loop frame while playing or scrubbing, otherwise the live composite. */
  readonly displayed = computed<RadarDisplayFrame | null>(() => {
    const i = this.playIndex();
    const frame = i === null ? null : this.history()[i];
    if (frame) return frame;
    const live = this.compositeMosaic();
    return live && live.displayField && live.isDisplayed !== false
      ? {
          field: live.displayField,
          width: live.fieldData.cropW,
          height: live.fieldData.cropH,
          coordinates: live.coordinates,
          timeMs: live.timing?.epochMs ?? null,
        }
      : null;
  });
  /** Fixed ~4 km grid over every radar's coverage, for storm tracking (the same for every loop frame). */
  readonly trackGrid = computed<TrackingGrid>(() => {
    const product = this.activeProduct();
    let s = 90, w = 180, n = -90, e = -180;
    for (const st of this.stations) {
      const [[bs, bw], [bn, be]] = st.products[product].bounds;
      s = Math.min(s, bs); w = Math.min(w, bw); n = Math.max(n, bn); e = Math.max(e, be);
    }
    return trackingGrid(s, w, n, e);
  });
  private historyToken = 0;
  private playTimer: ReturnType<typeof setInterval> | null = null;
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
      if (res.isDisplayed !== false && res.fieldData) count++;
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
  private readonly extrasFetchedAt = new Map<string, number>();
  private static readonly EXTRAS_REFRESH_MS = 4 * 60_000;

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
    this.extraResults.set(new Map());
    this.extrasFetchedAt.clear();
    this.compositeMosaic.set(null);
    this.clearHistory();
    this.fetchAllRadarSweeps();
  }

  setTransparent(transparent: boolean): void {
    this.transparentMode.set(transparent);
    this.allRadarResults.set(new Map());
    this.compositeMosaic.set(null);
    this.clearHistory();
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
          // When active product is 'caz' (merged mode), PPZ is fetched alongside; a missing one is simply left out of the merge.
          // IMD updates about every 10 minutes, so extras are refreshed every few minutes,
          // and the X-band radar's are skipped: its images are big and the Chennai S-band radar covers the same ground.
          const now = Date.now();
          const wantExtras = productKey === 'caz' && now - (this.extrasFetchedAt.get(station.id) ?? 0) >= RadarService.EXTRAS_REFRESH_MS;
          if (wantExtras) this.extrasFetchedAt.set(station.id, now);
          const extras = wantExtras
            ? await Promise.all(
                MERGED_PRODUCTS.filter(p => p !== productKey).map(async p => [p, await this.processStationSweep(station, p, isTransparent, false).catch(() => null)] as const)
              )
            : [];
          if (wantExtras && requestId === this.currentRequestId) {
            this.extraResults.update(map => {
              const next = new Map(map);
              for (const [p, r] of extras) {
                if (r) next.set(`${station.id}:${p}`, r);
                else next.delete(`${station.id}:${p}`);
              }
              return next;
            });
          }
          const res = await this.processStationSweep(station, productKey, isTransparent);
          if (res && requestId === this.currentRequestId) {
            // Unchanged image: same result object, nothing to redraw
            if (this.allRadarResults().get(station.id) === res) {
              if (extras.some(([, r]) => r)) this.scheduleMosaic(); // a merged scan may have changed even if CAZ did not
              continue;
            }
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
    isTransparent: boolean,
    /** The primary scan (CAZ) sets the station's timing and online state; the merged extras do not. */
    primary = true
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
      if (primary) this.stationTimings.update(m => new Map(m).set(station.id, timing!));
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
    const cacheId = `${station.id}:${productKey}`;
    const cached = this.sweepCache.get(cacheId);
    if (cached && cached.key === cacheKey) {
      if (!cached.result || cached.result.isDisplayed === isDisplayed) return cached.result;
      const updated = { ...cached.result, isDisplayed, timing };
      this.sweepCache.set(cacheId, { key: cacheKey, result: updated });
      return updated;
    }
    const processed = await this.decodeAndProcessSweep(station, productKey, productConfig, isTransparent, rawArrayBuf, timing, isDisplayed, primary);
    this.sweepCache.set(cacheId, { key: cacheKey, result: processed });
    return processed;
  }

  private async decodeAndProcessSweep(
    station: RadarStationConfig,
    productKey: RadarProductKey,
    productConfig: RadarStationConfig['products'][RadarProductKey],
    isTransparent: boolean,
    rawArrayBuf: ArrayBuffer,
    timing: RadarObservationTiming | null,
    isDisplayed: boolean,
    primary = true
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
    return this.processRgba(station, productKey, productConfig, isTransparent, rgba, w, h, timing, isDisplayed, primary);
  }

  /**
   * Turns one decoded radar picture into the station's intensity field on a 1024 x 1024 grid (~0.5 km), for the live
   * still or for a frame of the one-hour loop (`live` false: it does not change the station's online state).
   */
  private processRgba(
    station: RadarStationConfig,
    productKey: RadarProductKey,
    productConfig: RadarStationConfig['products'][RadarProductKey],
    isTransparent: boolean,
    rgba: Uint8ClampedArray | Uint8Array,
    w: number,
    h: number,
    timing: RadarObservationTiming | null,
    isDisplayed: boolean,
    live: boolean
  ): ProcessedRadarResult | null {
    // Layout check: if the image no longer matches the configured crop it is not a radar sweep
    // (IMD swaps in an "under maintenance" photo) or the product layout has changed. Decoding it
    // anyway would paint photo pixels as fake echoes.
    const crop = productConfig.crop;
    const layoutMatches = !crop || (crop.x + crop.w <= w + 2 && crop.y + crop.h <= h + 2);
    if (live) this.setStationUnavailable(station.id, !layoutMatches);
    if (!layoutMatches) {
      if (live) {
        console.warn(
          `[RadarService] Station "${station.name}" ${productKey.toUpperCase()} image is ${w}x${h}, ` +
          `which does not match its configured layout. Treating station as offline.`
        );
      }
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

    let hasAnyEcho = false;
    const isXBand = station.band === 'X-Band';

    // 3. Classify every source pixel once, at the image's own resolution. Resampling the colour classes (rather than
    // the picture) lets the intensity be interpolated smoothly below, instead of copying stair-stepped blocks.
    const classes = new Float32Array(cropW * cropH);
    for (let sy = 0; sy < cropH; sy++) {
      const py = cropY + sy;
      if (py < 0 || py >= h) continue;
      for (let sx = 0; sx < cropW; sx++) {
        const px = cropX + sx;
        if (px < 0 || px >= w) continue;
        const srcIdx = (py * w + px) * 4;
        classes[sy * cropW + sx] = this.classifyRainPixel(rgba[srcIdx], rgba[srcIdx + 1], rgba[srcIdx + 2], isTransparent, isXBand, productConfig.palette);
      }
    }
    const rawGrid = resampleBilinear(classes, cropW, cropH, outSize);

    // Circular dish mask: completely clip anything outside the radar sweep circle
    for (let outY = 0; outY < outSize; outY++) {
      const dy = outY - halfSize;
      const rowOffset = outY * outSize;
      for (let outX = 0; outX < outSize; outX++) {
        const dx = outX - halfSize;
        if (Math.sqrt(dx * dx + dy * dy) > maxRadius) rawGrid[rowOffset + outX] = 0;
        else if (rawGrid[rowOffset + outX] > 0) hasAnyEcho = true;
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
      // 4. Natural blending: the smoothly resampled intensity is blurred with a Gaussian (about 1 km), which rounds
      // every contour and blends the colour classes into each other without growing the echoes.
      const blurredGrid = blurSeparable(rawGrid, outSize, gaussianKernel(RADAR_BLUR_SIGMA_PX));

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

          finalField[rowOffset + x] = 1.0;
        }
      }
    }

    const dataUrl = ''; // stations are only shown through the mosaic

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


  /** Resolution of the composite: 0.5 km per pixel, capped so a phone's GPU can take it. */
  private static readonly MOSAIC_MAX_PX = radarMosaicMaxPx(isPhone());

  private composeMosaic(sources: Iterable<[string, ProcessedRadarResult]>): ProcessedRadarResult | null {
    return composeRadarMosaic(this.stations, sources, MOSAIC_KM_PER_PX, RadarService.MOSAIC_MAX_PX, this.activeProduct());
  }

  /** Rebuilds the live composite from the latest still of every radar. */
  private generateMergedMosaic(): void {
    // In merged mode ('caz'), combine CAZ with PPZ extras; in standalone modes ('ppz', 'ppi'), compose that product's scans
    const sources = this.activeProduct() === 'caz'
      ? [...this.allRadarResults(), ...this.extraResults()]
      : [...this.allRadarResults()];
    this.compositeMosaic.set(this.composeMosaic(sources));
  }

  /** The live composite on the storm-tracking grid. */
  liveTrack(): { timeMs: number; track: Float32Array } | null {
    const live = this.compositeMosaic();
    if (!live?.fieldData || !live.timing?.epochMs) return null;
    return { timeMs: live.timing.epochMs, track: this.toTrack(live.fieldData) };
  }

  private toTrack(fd: RadarFieldData): Float32Array {
    const [[south, west], [north, east]] = fd.bounds;
    return sampleToGrid({ field: fd.field, width: fd.cropW, height: fd.cropH, south, west, north, east }, this.trackGrid());
  }

  /**
   * Builds the one-hour loop: downloads each radar's animated GIF, decodes the frames of the last hour with the same
   * clean-up as the live still, and merges them into one composite per 10-minute step.
   */
  async loadHistory(): Promise<void> {
    const product = this.activeProduct();
    const isTransparent = this.transparentMode();
    if (!this.historyAvailable() || this.historyLoading()) return;
    const token = ++this.historyToken;
    this.historyLoading.set(true);
    this.historyProgress.set(0);
    try {
      // 1. each radar's scans in the last hour: the frames of its animation, plus its live still (IMD updates the
      // animations less often than the stills, so the still is often the newest scan)
      type Scan = { timeMs: number; index: number; res?: ProcessedRadarResult };
      const live = this.allRadarResults();
      const sources = (
        await Promise.all(
          this.stations.map(async station => {
            if (this.unavailableStations().has(station.id)) return null;
            const file = animationFile(station.code, product);
            // The Pallikaranai X-band animation is over 20 MB, and the Chennai S-band radar covers the same area,
            // so the loop leaves out its animation (its live still is still used).
            const bytes = file && station.band !== 'X-Band' ? await this.fetchRadarFile(file) : null;
            if (token !== this.historyToken) return null;
            let reader: GifReader | null = null;
            let frames: Scan[] = [];
            if (bytes) {
              try {
                reader = new GifReader(bytes);
                frames = recentFrames(gifFrameTimestamps(bytes));
              } catch {
                reader = null;
              }
            }
            const still = live.get(station.id);
            const stillMs = still?.timing?.epochMs;
            if (still?.fieldData && stillMs && !frames.some(f => Math.abs(f.timeMs - stillMs) < 60_000)) {
              frames.push({ timeMs: stillMs, index: -1, res: still });
            }
            frames.sort((a, b) => a.timeMs - b.timeMs);
            return frames.length > 0 ? { station, reader, frames } : null;
          })
        )
      ).filter((x): x is NonNullable<typeof x> => x !== null);
      if (token !== this.historyToken || sources.length === 0) return;

      // 2. one composite per 10-minute step, each radar contributing its newest scan not after the step. The loop
      // ends just before the newest scans: the live picture itself is its last step.
      const newest = Math.max(...sources.map(src => src.frames.at(-1)!.timeMs));
      const slots = historySlots(newest).slice(0, -1);
      const decoded = new Map<string, ProcessedRadarResult | null>(); // station|time -> field
      const field = (src: (typeof sources)[number], scan: Scan): ProcessedRadarResult | null => {
        if (scan.res) return scan.res;
        if (!src.reader) return null;
        const key = `${src.station.id}|${scan.timeMs}`;
        if (!decoded.has(key)) {
          const { width, height } = src.reader;
          const rgba = new Uint8Array(width * height * 4);
          src.reader.decodeAndBlitFrameRGBA(scan.index, rgba);
          const config = src.station.products[product];
          decoded.set(key, this.processRgba(src.station, product, config, isTransparent, rgba, width, height, null, true, false));
        }
        return decoded.get(key)!;
      };
      const frames: RadarHistoryFrame[] = [];
      for (let k = 0; k < slots.length; k++) {
        const entries: [string, ProcessedRadarResult][] = [];
        for (const src of sources) {
          const scan = scanForSlot(src.frames, slots[k]);
          if (!scan) continue;
          const res = field(src, scan);
          if (res) entries.push([src.station.id, res]);
          await yieldToBrowser(); // keep the page responsive while frames decode
          if (token !== this.historyToken) return;
        }
        // drop decoded scans older than every station's scan for this step (later steps only use newer ones)
        for (const key of [...decoded.keys()]) {
          const [id, t] = key.split('|');
          const src = sources.find(x => x.station.id === id);
          const cur = src && scanForSlot(src.frames, slots[k]);
          if (cur && Number(t) < cur.timeMs) decoded.delete(key);
        }
        const composed = entries.length > 0 ? this.composeMosaic(entries) : null;
        if (composed?.displayField) {
          frames.push({
            field: composed.displayField,
            width: composed.fieldData.cropW,
            height: composed.fieldData.cropH,
            coordinates: composed.coordinates,
            timeMs: slots[k],
            track: this.toTrack(composed.fieldData),
          });
        }
        this.historyProgress.set((k + 1) / slots.length);
      }
      this.replaceHistory(frames);
    } finally {
      if (token === this.historyToken) this.historyLoading.set(false);
    }
  }

  private async fetchRadarFile(file: string): Promise<Uint8Array | null> {
    for (const url of [`/imd-radar/${file}`, `https://mausam.imd.gov.in/Radar/${file}`]) {
      try {
        const res = await fetch(`${url}?_t=${Math.floor(Date.now() / 60000)}`);
        if (!res.ok) continue;
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return bytes;
      } catch {
        // try the next route
      }
    }
    return null;
  }

  private replaceHistory(frames: RadarHistoryFrame[]): void {
    const old = this.history();
    const wasLive = this.playIndex() === null;
    this.history.set(frames);
    if (!wasLive) this.playIndex.set(frames.length > 0 ? Math.min(this.playIndex()!, frames.length - 1) : null);
    void old; // the loop frames hold plain arrays now: nothing to release by hand
  }

  clearHistory(): void {
    this.historyToken++;
    this.historyLoading.set(false);
    this.pause();
    this.playIndex.set(null);
    this.replaceHistory([]);
  }

  /** Show a loop frame (or null for live). */
  setPlayIndex(i: number | null): void {
    const n = this.history().length;
    this.playIndex.set(i === null || n === 0 ? null : Math.min(Math.max(Math.round(i), 0), n - 1));
  }

  /** Play the hour; the loop ends on the live picture and holds there a moment before starting again. */
  async togglePlay(): Promise<void> {
    if (this.playing()) {
      this.pause();
      return;
    }
    if (this.history().length === 0) await this.loadHistory();
    const n = this.history().length;
    if (n < 2) return;
    this.playing.set(true);
    let hold = 0;
    if (this.playIndex() === null) this.playIndex.set(0);
    this.playTimer = setInterval(() => {
      const i = this.playIndex();
      if (i === null) {
        if (++hold >= 2) this.playIndex.set(0); // hold on live, then restart
        return;
      }
      hold = 0;
      this.playIndex.set(i + 1 < this.history().length ? i + 1 : null);
    }, 700);
  }

  pause(): void {
    this.playing.set(false);
    if (this.playTimer) clearInterval(this.playTimer);
    this.playTimer = null;
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

    // read the picture on screen: the live mosaic, or the loop frame being played or scrubbed
    const shown = this.displayed();
    if (shown) {
      const { field, width: cropW, height: cropH, coordinates } = shown;
      const maxLat = coordinates[0][1];
      const minLat = coordinates[2][1];
      const minLng = coordinates[0][0];
      const maxLng = coordinates[1][0];

      if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) {
        // rows are evenly spaced in latitude, columns in longitude, first and last on the edges
        const srcX = ((lng - minLng) / (maxLng - minLng)) * (cropW - 1);
        const srcY = ((maxLat - lat) / (maxLat - minLat)) * (cropH - 1);

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
          maxV = dequantizeRadar((s00 * (1 - wx) + s10 * wx) * (1 - wy) + (s01 * (1 - wx) + s11 * wx) * wy);

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
      let label = 'Light Echo';
      let color = '#3ad9e4ff'; // Deep Blue
      let rate = '< 1.0 mm/h';

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
        color = '#afc600ff'; // Green
        rate = '2.5 – 10 mm/h';
      } else if (dbz >= 18) {
        label = 'Light Rain';
        color = '#00a33fff'; // Sky Blue
        rate = '1.0 – 2.5 mm/h';
      } else {
        label = 'Light Echo';
        color = '#3ad9e4ff'; // Deep Blue
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
