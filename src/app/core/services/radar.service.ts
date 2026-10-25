import { Injectable, signal, computed, effect, inject, untracked, OnDestroy } from '@angular/core';
import {
  IMD_RADAR_STATIONS,
  RadarStationConfig,
  RadarProductKey,
  RadarObservationTiming,
  RadarHoverInfo,
  RadarFieldData,
  ProcessedRadarResult
} from '../domain/models/radar.model';

import { RADAR_FIELD_SIZE, layoutMatches, looksLikeRadar, processRadarPixels } from './radar-process';
import { HistoryHandle, RadarProcessor, StillResult } from './radar-processor';
import { animationFile, gifFrameTimestamps, historySlots, recentFrames, scanForSlot } from './radar-history';
import { stampEpoch, type StampTime } from './radar-stamp';
import { MosaicSource, RadarCompute } from './radar-compute';
import { decodeRadarGif } from './radar-gif-decode';
import { cachedRadarPicture, keepRadarPicture } from './radar-picture-cache';
import { inspectRadar } from './radar-inspector';
import { readHiddenStations, writeHiddenStations } from './radar-station-prefs';
import { IMD_WRITE_GAP_MS, LOOK_LEAD_MS, extractRadarIsoTimestamp, pictureNotDue, radarTimingFromDate, scanNotDue } from './radar-timing';
import { TrackingGrid, sampleToGrid, trackingGrid } from './storm-tracking';
import { isPhone, radarMosaicMaxPx } from '../ui/device-profile';
import { MAX_SCAN_AGE_MIN, MOSAIC_KM_PER_PX, type MosaicRing, ringKey } from './radar-mosaic';
import { RadarCoverageService } from './radar-coverage.service';
import { BOT_CAPTURE } from '../ui/bot-capture';
import { MARSHALL_PALMER_A, RadarSamples, lastHourRain, sampleAll } from './radar-sample';
import { MapLayerService } from './map-layer.service';

/** What the map shows for the radar: the mosaic's intensity (one byte per pixel) placed by its corners, and its time. */
export interface RadarDisplayFrame {
  field: Uint8Array;
  /** How fully each pixel is drawn (255: in full): an echo older than another radar's scan of the same place is fainter. Absent: all in full. */
  fade?: Uint8Array;
  width: number;
  height: number;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  timeMs: number | null;
}

/** One step of the nowcast: the live picture slid ahead along the motion of the rain (see radar-nowcast.ts). It is a guess, not an observation. */
export interface NowcastFrame extends RadarDisplayFrame {
  timeMs: number;
  /** Minutes after the live picture. */
  leadMin: number;
}

/** One step of the one-hour loop: its picture and the intensity on the ~4 km storm-tracking grid. */
export interface RadarHistoryFrame extends RadarDisplayFrame {
  timeMs: number;
  track: Float32Array;
}

/** What the radar panel shows: one product on its own, or every station's stack (`all`). */
export type RadarView = RadarProductKey | 'all';

/**
 * The stack (the owner, 24 Oct 2026: "first ppz for coverage, on top of that caz and on top of that ppi ... circle inside circle"): each
 * station's PPI inside, its CAZ around that and its PPZ outside, each with its own scan time. Listed inside out.
 */
export const STACK_PRODUCTS: readonly RadarProductKey[] = ['ppi', 'caz', 'ppz'];
/** A ring reaches this far inside the one within it, so the two meet without a gap (the inner picture's last pixels are its border). */
const RING_OVERLAP_KM = 1.5;

/**
 * The rings of one station's stack from the products that have a picture to show (`has`): sorted by range (PPI, CAZ, PPZ where two reach
 * as far), each drawn from the range of the one inside it; a product that reaches no further than the one inside it is left out.
 */
export function stackRings(station: RadarStationConfig, has: (p: RadarProductKey) => boolean): [RadarProductKey, MosaicRing][] {
  const order = STACK_PRODUCTS.filter(p => has(p) && !station.products[p]?.unmeasured);
  order.sort((a, b) => station.products[a].rangeKm - station.products[b].rangeKm);
  const out: [RadarProductKey, MosaicRing][] = [];
  let reach = 0;
  for (const p of order) {
    const km = station.products[p].rangeKm;
    if (km <= reach) continue;
    out.push([p, { product: p, innerKm: reach > 0 ? Math.max(0, reach - RING_OVERLAP_KM) : 0, outermost: false }]);
    reach = km;
  }
  if (out.length > 0) out[out.length - 1][1].outermost = true;
  return out;
}

/** The product whose picture stands for a station in the stack (its scan time and its online state): CAZ, else PPZ, else PPI. */
export function stackPrimary(station: RadarStationConfig): RadarProductKey | null {
  return (['caz', 'ppz', 'ppi'] as const).find(p => !station.products[p]?.unmeasured) ?? null;
}

const yieldToBrowser = () => new Promise<void>(r => setTimeout(r, 0));

export { RADAR_COLOR_STOPS, sampleRadarColorRamp } from './radar-field';

export { removeRadialInterference } from './radar-process';
export { IMD_WRITE_GAP_MS, pictureNotDue, scanNotDue } from './radar-timing';


@Injectable({ providedIn: 'root' })
export class RadarService implements OnDestroy {
  readonly stations = IMD_RADAR_STATIONS;

  // Active Station & Product Signals
  readonly activeStationId = signal<string>('karaikal');
  readonly activeStation = computed<RadarStationConfig>(() => {
    const id = this.activeStationId();
    return this.stations.find(s => s.id === id) || this.stations[0];
  });

  /**
   * The radars turned off in the panel: left out of the mosaic, the loop and the readout. Their pictures are still fetched, so
   * turning one back on shows it at once. Both can be off (the map then shows no radar). Remembered between visits.
   */
  readonly hiddenStations = signal<ReadonlySet<string>>(readHiddenStations());

  /** The view in the panel: every station's stack (the default), or one product on its own. */
  readonly activeView = signal<RadarView>('all');
  readonly stacked = computed(() => this.activeView() === 'all');
  /** The product on show; for the stack, the CAZ (the loop's animations, the stations' scan times and their online state). */
  readonly activeProduct = computed<RadarProductKey>(() => {
    const v = this.activeView();
    return v === 'all' ? 'caz' : v;
  });
  /** The product whose range the beams and the coverage are worked out to: the stack's outermost (PPZ) in the All view. */
  readonly coverageProduct = computed<RadarProductKey>(() => (this.stacked() ? 'ppz' : this.activeProduct()));
  /** The stack's pictures, by `stationId:product` (every product of the stack, the primary one too). */
  readonly ringResults = signal<Map<string, ProcessedRadarResult>>(new Map());
  readonly transparentMode = signal<boolean>(true);
  readonly radarOpacity = signal<number>(1.0);
  /**
   * Leave out faint echoes where the beam passes high above the ground (far from a radar, behind mountains): there they are mostly cloud or rain
   * that never lands, and on a radar whose clutter filter is off, noise (see radar-coverage.ts). Remembered between visits.
   */
  private readonly coverage = inject(RadarCoverageService);

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

  // ── One-hour loop (from IMD's animated GIFs) ──
  readonly history = signal<RadarHistoryFrame[]>([]);
  readonly historyLoading = signal(false);
  /** 0..1 while the loop is being built. */
  readonly historyProgress = signal(0);
  /** Loop position: an index into `history`, or null for the live picture. */
  readonly playIndex = signal<number | null>(null);
  readonly playing = signal(false);
  /** The nowcast, ten minutes apart from ten minutes ahead (set by RadarNowcastService); empty until it has been worked out. */
  readonly nowcast = signal<NowcastFrame[]>([]);
  /** Position in `nowcast` while one of its pictures is on the map, else null (`playIndex` is the loop's; both null is the live picture). */
  readonly leadIndex = signal<number | null>(null);
  /** Where the radar's clock is, as one number along the whole strip: the loop's frames, then the live picture, then the nowcast. */
  readonly cursor = computed(() => {
    const h = this.history().length;
    const p = this.playIndex();
    if (p !== null) return p;
    const l = this.leadIndex();
    return l !== null ? h + 1 + l : h;
  });
  /** The last position of the strip (the live picture when there is no nowcast). */
  readonly cursorMax = computed(() => this.history().length + this.nowcast().length);
  /** IMD publishes animations for the max-reflectivity (CAZ) and rain-rate (SRI) products only. */
  readonly historyAvailable = computed(() => animationFile('x', this.activeProduct()) !== null);
  /** The live picture as it is drawn (every echo, nothing filtered out), or null when there is none or even its newest scan is too old to show. */
  readonly liveFrame = computed<RadarDisplayFrame | null>(() => {
    const live = this.compositeMosaic();
    // the whole picture goes when even its newest scan is older than MAX_SCAN_AGE_MIN (the clock ticks between refreshes)
    const stale = !!live?.timing?.epochMs && this.liveClock() - live.timing.epochMs > MAX_SCAN_AGE_MIN * 60_000;
    return live && live.displayField && live.isDisplayed !== false && !stale
      ? {
          field: live.displayField,
          fade: live.displayFade,
          width: live.fieldData.cropW,
          height: live.fieldData.cropH,
          coordinates: live.coordinates,
          timeMs: live.timing?.epochMs ?? null,
        }
      : null;
  });
  /** The picture on the map: a step of the nowcast or a loop frame while one is chosen, otherwise the live composite. */
  readonly displayed = computed<RadarDisplayFrame | null>(() => {
    const ahead = this.leadIndex();
    const guess = ahead === null ? null : this.nowcast()[ahead];
    if (guess) return guess;
    const i = this.playIndex();
    const frame = i === null ? null : this.history()[i];
    if (frame) return frame;
    return this.liveFrame();
  });
  /** Fixed ~4 km grid over every radar's coverage, for storm tracking (the same for every loop frame). */
  readonly trackGrid = computed<TrackingGrid>(() => {
    const product = this.coverageProduct();
    let s = 90, w = 180, n = -90, e = -180;
    for (const st of this.stations) {
      const [[bs, bw], [bn, be]] = st.products[product].bounds;
      s = Math.min(s, bs); w = Math.min(w, bw); n = Math.max(n, bn); e = Math.max(e, be);
    }
    return trackingGrid(s, w, n, e);
  });
  private historyToken = 0;
  private playTimer: ReturnType<typeof setInterval> | null = null;

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
  // Last processed sweep per station, keyed by a hash of the GIF bytes. IMD writes new pictures
  // about every five minutes, so most 1-minute refreshes can reuse the previous result.
  private sweepCache = new Map<string, { key: string; result: ProcessedRadarResult | null }>();
  /** The scan time read off each picture that prints it (see radar-stamp.ts), kept per picture so an unchanged one is not decoded again. */
  private stampCache = new Map<string, { hash: string; time: StampTime | null }>();
  /**
   * Per station and product (`stationId:product`): when its newest picture was written (the file's Last-Modified time) and
   * when it was last asked for. They decide when the station is asked for again (see pictureNotDue).
   */
  private readonly pictureWrittenAt = new Map<string, number>();
  private readonly pictureFetchedAt = new Map<string, number>();
  /** Decodes the pictures and builds their intensity fields in web workers (see radar-processor.ts). */
  private readonly processor = new RadarProcessor();

  /** Something off the radar layer needs the live picture (the place card's rain line, through RadarNowcastService.wanted). */
  readonly liveWanted = signal(false);
  private readonly layers = inject(MapLayerService);
  /**
   * Whether the radars are fetched at all: while the radar is on the map, or something else needs its live picture. With 45 radars (and
   * three pictures each in the stack) fetching, decoding and composing them every minute slowed the forecast maps down while the radar
   * was not even shown (the owner, 24 Oct 2026: "the numerical models are taking a lot of time to load").
   */
  readonly needed = computed(() => BOT_CAPTURE || this.liveWanted() || this.layers.layers().some(l => l.id === 'radar' && l.active));

  constructor() {
    // the first fetch, and a fresh one whenever the radar is wanted again (its pictures may be old by then)
    effect(() => {
      if (this.needed()) untracked(() => void this.fetchAllRadarSweeps());
    });
    this.startAutoRefresh();
    this.startLiveClock();
    // each new live picture pushes the one before it into the loop, so the last hour keeps up without downloading the animations again
    effect(() => {
      this.compositeMosaic();
      untracked(() => this.rollHistory());
    });
    // the nowcast bot reads the radar over the rain gauges' cells from here (see radar-sample.ts); nothing of it runs for a visitor
    if (BOT_CAPTURE) {
      (window as unknown as { __atmosSample?: (points: [number, number][], halfDeg: number) => RadarSamples }).__atmosSample = (points, halfDeg) =>
        sampleAll(this.liveFrame(), this.nowcast(), points, halfDeg);
    }
  }

  /** The live picture before the newest, kept so it can join the loop when the next one arrives. */
  private previousLive: ProcessedRadarResult | null = null;

  private rollHistory(): void {
    const live = this.compositeMosaic();
    const t = live?.timing?.epochMs;
    if (!live?.displayField || !t) return;
    const prev = this.previousLive;
    this.previousLive = live;
    const frames = this.history();
    if (!prev || prev === live || frames.length === 0 || !prev.displayField || !prev.timing?.epochMs) return;
    const prevMs = prev.timing.epochMs;
    if (t <= prevMs || prevMs - frames[frames.length - 1].timeMs < 8 * 60_000) return;
    const next: RadarHistoryFrame = {
      field: prev.displayField,
      width: prev.fieldData.cropW,
      height: prev.fieldData.cropH,
      coordinates: prev.coordinates,
      timeMs: prevMs,
      track: this.toTrack(prev.fieldData),
    };
    const kept = [...frames, next].filter(f => t - f.timeMs <= 70 * 60_000);
    const dropped = frames.length + 1 - kept.length;
    const at = this.playIndex();
    this.history.set(kept);
    if (at !== null) this.playIndex.set(Math.min(Math.max(at - dropped, 0), kept.length - 1));
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
      if (this.needed()) this.fetchAllRadarSweeps();
    }, 60000); // 1-minute auto sync

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.needed()) {
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

  isStationShown(stationId: string): boolean {
    return !this.hiddenStations().has(stationId);
  }

  /**
   * Turns one radar on or off and rebuilds the mosaic and the loop without it. The map stays where it is: a radar turned on
   * becomes the one the status line is about, one turned off hands that to a radar still on.
   */
  toggleStation(stationId: string): void {
    const hidden = new Set(this.hiddenStations());
    const turningOn = hidden.has(stationId);
    if (turningOn) hidden.delete(stationId);
    else hidden.add(stationId);
    this.hiddenStations.set(hidden);
    writeHiddenStations(hidden);
    if (turningOn) this.activeStationId.set(stationId);
    else if (hidden.has(this.activeStationId())) {
      const next = this.stations.find(s => !hidden.has(s.id));
      if (next) this.activeStationId.set(next.id);
    }
    this.clearHistory();
    this.generateComposite();
  }

  setProduct(product: RadarView): void {
    this.activeView.set(product);
    this.allRadarResults.set(new Map());
    this.ringResults.set(new Map());
    this.forgetPictureTimes();
    this.compositeMosaic.set(null);
    this.clearHistory();
    if (this.needed()) this.fetchAllRadarSweeps();
  }

  setOpacity(opacity: number): void {
    this.radarOpacity.set(Math.max(0.1, Math.min(1.0, opacity)));
  }

  async fetchRadarSweep(): Promise<void> {
    await this.fetchAllRadarSweeps();
  }

  /**
   * Fetches and processes every station's newest scan. A call made while an identical refresh (same product and mode) is still
   * running joins that one instead of downloading every picture again (the constructor, the layer switch and the 1-minute timer
   * often overlap at start-up).
   */
  fetchAllRadarSweeps(): Promise<void> {
    const key = `${this.activeView()}|${this.transparentMode()}`;
    const running = this.inFlightSweeps;
    // a run that has hung (a request that never answers) is not joined: a new one starts instead
    if (running?.key === key && Date.now() - running.startedAt < RadarService.SWEEP_JOIN_MAX_MS) return running.done;
    const done = this.runSweepFetch().finally(() => {
      if (this.inFlightSweeps?.done === done) this.inFlightSweeps = null;
    });
    this.inFlightSweeps = { key, done, startedAt: Date.now() };
    return done;
  }

  private inFlightSweeps: { key: string; done: Promise<void>; startedAt: number } | null = null;
  private static readonly SWEEP_JOIN_MAX_MS = 90_000;

  private static readonly PREPROCESSED_SOURCES = [
    'https://gowthamgta.github.io/atmos-radar/',
    '/data/radar/',
  ];

  /**
   * Fetches the preprocessed All-India composite published by the background workflow (gowthamgta/atmos-radar).
   * Returns true when the manifest and binary intensity field were loaded and displayed.
   */
  private async tryFetchPreprocessedComposite(requestId: number): Promise<boolean> {
    const cacheBuster = Math.floor(Date.now() / 60_000);

    for (const base of RadarService.PREPROCESSED_SOURCES) {
      try {
        const manifestRes = await fetch(`${base}manifest.json?_t=${cacheBuster}`);
        if (!manifestRes.ok) continue;

        const manifest = await manifestRes.json();
        if (!manifest || !manifest.width || !manifest.height || !manifest.coordinates) continue;

        if (manifest.updatedAtEpochMs && Date.now() - manifest.updatedAtEpochMs > MAX_SCAN_AGE_MIN * 60_000) {
          continue;
        }

        const binRes = await fetch(`${base}field.bin?_t=${cacheBuster}`);
        if (!binRes.ok) continue;

        const binBuf = await binRes.arrayBuffer();
        const totalPx = manifest.width * manifest.height;
        if (binBuf.byteLength < totalPx) continue;

        if (requestId !== this.currentRequestId) return false;

        const displayField = new Uint8Array(binBuf, 0, totalPx);
        const displayFade = binBuf.byteLength >= totalPx * 2 ? new Uint8Array(binBuf, totalPx, totalPx) : undefined;

        // Reconstruct continuous Float32Array intensity field (0..6.0) for liveTrack and nowcast rain-sampling
        const field = new Float32Array(totalPx);
        for (let i = 0; i < totalPx; i++) {
          field[i] = (displayField[i] / 255) * 6.0;
        }

        const result: ProcessedRadarResult = {
          stationId: 'composite-mosaic',
          dataUrl: '',
          displayField,
          displayFade,
          coordinates: manifest.coordinates,
          fieldData: {
            field,
            cropW: manifest.width,
            cropH: manifest.height,
            cx: manifest.width / 2,
            cy: manifest.height / 2,
            radius: Math.hypot(manifest.width, manifest.height) / 2,
            bounds: manifest.bounds,
          },
          timing: manifest.updatedAtEpochMs
            ? radarTimingFromDate(new Date(manifest.updatedAtEpochMs), 'radar_metadata', false)
            : null,
          isDisplayed: true,
        };

        this.compositeMosaic.set(result);

        // Update station timings from manifest so all station cards in UI reflect real IMD scan times & freshness
        if (Array.isArray(manifest.stations)) {
          this.stationTimings.update(m => {
            const next = new Map(m);
            for (const s of manifest.stations) {
              if (s.id && s.timing) {
                next.set(s.id, s.timing);
              }
            }
            return next;
          });
        }

        return true;
      } catch {
        // Fall back to next source
      }
    }

    return false;
  }

  private async runSweepFetch(): Promise<void> {
    const requestId = ++this.currentRequestId;
    this.isRefreshing.set(true);

    const isTransparent = this.transparentMode();
    const stacked = this.stacked();

    // In stacked ('all') mode with all default stations, attempt to fetch the preprocessed composite first
    if (stacked && this.hiddenStations().size === 0) {
      try {
        const loaded = await this.tryFetchPreprocessedComposite(requestId);
        if (loaded) {
          if (requestId === this.currentRequestId) {
            this.isRefreshing.set(false);
            this.lastSyncTime.set(
              new Date().toLocaleTimeString('en-IN', { hour12: true, timeZone: 'Asia/Kolkata' })
            );
          }
          return;
        }
      } catch {
        // Fall back to client-side sweep fetching
      }
    }

    // one job per picture: the product on show, or every product of each station's stack (its primary one first, then the others)
    type Job = { station: RadarStationConfig; productKey: RadarProductKey; primary: boolean };
    const queue: Job[] = [];
    if (!stacked) {
      for (const station of this.stations) queue.push({ station, productKey: this.activeProduct(), primary: true });
    } else {
      const rest: Job[] = [];
      for (const station of this.stations) {
        const primary = stackPrimary(station);
        if (!primary) continue;
        queue.push({ station, productKey: primary, primary: true });
        for (const p of STACK_PRODUCTS) if (p !== primary && !station.products[p].unmeasured) rest.push({ station, productKey: p, primary: false });
      }
      queue.push(...rest);
    }
    const concurrency = 6;

    const worker = async () => {
      while (queue.length > 0) {
        if (requestId !== this.currentRequestId) break;
        const job = queue.shift();
        if (!job) break;
        const { station, productKey, primary } = job;
        // IMD publishes a new scan about every 5 minutes: while the station's newest scan is younger than the next one is due,
        // downloading the same picture again only costs bandwidth, so the station waits until it is due
        if (this.notDueYet(station, productKey)) continue;
        try {
          const res = await this.processStationSweep(station, productKey, isTransparent, primary);
          if (stacked && requestId === this.currentRequestId) this.setRing(ringKey(station.id, productKey), res);
          if (!primary) continue;
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
      this.flushMosaic();
      this.isRefreshing.set(false);
      this.lastSyncTime.set(
        new Date().toLocaleTimeString('en-IN', { hour12: true, timeZone: 'Asia/Kolkata' })
      );
    }
  }

  /**
   * Rebuilding the composite takes a good fraction of a second, so station updates arriving close together (one per station
   * on every refresh) are merged into a single rebuild, and rebuilds are spaced at least `MOSAIC_MIN_GAP_MS` apart. The last
   * one of a refresh is not waited for (see `flushMosaic`).
   */
  private static readonly MOSAIC_MIN_GAP_MS = 1500;
  private lastMosaicAt = 0;

  private scheduleMosaic(): void {
    if (this.mosaicTimer) return;
    const wait = Math.max(150, this.lastMosaicAt + RadarService.MOSAIC_MIN_GAP_MS - Date.now());
    this.mosaicTimer = setTimeout(() => {
      this.mosaicTimer = null;
      this.lastMosaicAt = Date.now();
      this.generateComposite();
    }, wait);
  }

  /** Builds the composite now if a rebuild is waiting (the end of a refresh: every station's newest scan is in). */
  private flushMosaic(): void {
    if (!this.mosaicTimer) return;
    clearTimeout(this.mosaicTimer);
    this.mosaicTimer = null;
    this.lastMosaicAt = Date.now();
    this.generateComposite();
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

  /** Keeps (or drops, for null) one picture of the stack, and asks for the mosaic to be rebuilt when it changed. */
  private setRing(key: string, res: ProcessedRadarResult | null): void {
    const map = this.ringResults();
    if ((map.get(key) ?? null) === res) return;
    const next = new Map(map);
    if (res) next.set(key, res);
    else next.delete(key);
    this.ringResults.set(next);
    this.scheduleMosaic();
  }

  /** The results were dropped (new product or transparency): every station is asked for again, whatever its write time said. */
  private forgetPictureTimes(): void {
    this.pictureWrittenAt.clear();
    this.pictureFetchedAt.clear();
  }

  /** True while the station's next picture is not due yet, so asking for it now would only return the same picture. */
  private notDueYet(station: RadarStationConfig, product: RadarProductKey): boolean {
    const key = `${station.id}:${product}`;
    const written = this.pictureWrittenAt.get(key);
    // no write time from the server: fall back to the scan time read off the picture
    const last = this.stacked() ? this.ringResults().get(key) : this.allRadarResults().get(station.id);
    if (written === undefined) return scanNotDue(last?.timing, Date.now(), IMD_WRITE_GAP_MS - LOOK_LEAD_MS);
    return pictureNotDue(Date.now(), written, this.pictureFetchedAt.get(key) ?? 0);
  }

  async processStationSweep(
    station: RadarStationConfig,
    productKey: RadarProductKey,
    isTransparent: boolean,
    /** False for the stack's other pictures: they do not set the station's scan time nor its online state. */
    primary = true
  ): Promise<ProcessedRadarResult | null> {
    const productConfig = station.products[productKey] || station.products.caz;
    // a product whose picture's layout was never measured is not drawn (it would put the echoes in the wrong place)
    if (productConfig.unmeasured) return null;
    // One address per minute: the proxy caches for 60 s, so the same picture asked for twice in a minute is downloaded once
    const cacheBuster = Math.floor(Date.now() / 60_000);

    const proxies = [
      `/imd-radar/${productConfig.file}`, // Netlify CDN edge proxy (production) & Vite dev proxy (local)
      `/.netlify/functions/radar?file=${productConfig.file}`, // Netlify serverless function fallback
      productConfig.url // Direct fallback
    ];

    let rawArrayBuf: ArrayBuffer | null = null;
    let sweepHeaderDate: Date | null = null;
    // true when that date is the file's own last-modified time (when IMD wrote the scan), not the response's send time
    let sweepHeaderIsWriteTime = false;
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
              binaryTiming = extractRadarIsoTimestamp(buf);
              const lastMod = response.headers.get('last-modified') || response.headers.get('date');
              sweepHeaderIsWriteTime = !!response.headers.get('last-modified');
              if (lastMod) {
                sweepHeaderDate = new Date(lastMod);
              }
              void keepRadarPicture(`${station.id}:${productKey}`, buf, response.headers.get('last-modified'));
              break;
            }
          }
        }
      } catch {
        // Fallback to next proxy
      }
    }

    // IMD cannot be reached: the last good picture kept in the browser, with its own time (too old a one is left out below, as always)
    let fromKept = false;
    if (!rawArrayBuf) {
      const kept = await cachedRadarPicture(`${station.id}:${productKey}`);
      if (!kept) return null;
      rawArrayBuf = kept.bytes;
      binaryTiming = extractRadarIsoTimestamp(kept.bytes);
      sweepHeaderDate = kept.lastModified ? new Date(kept.lastModified) : null;
      sweepHeaderIsWriteTime = !!kept.lastModified;
      fromKept = true;
    }

    // when the picture was written and when it was asked for: the next look is timed from these (see notDueYet)
    const pictureKey = `${station.id}:${productKey}`;
    if (!fromKept) this.pictureFetchedAt.set(pictureKey, Date.now());
    if (sweepHeaderIsWriteTime && sweepHeaderDate && !isNaN(sweepHeaderDate.getTime())) this.pictureWrittenAt.set(pictureKey, sweepHeaderDate.getTime());

    // ── Observation Timestamp Extraction & Per-Station Freshness Calculation ──
    let timing: RadarObservationTiming | null = binaryTiming;
    // No timestamp in the GIF: some pictures print the scan time in their side panel. The server's "last modified" only says
    // when the file was copied, so the printed time wins where there is one (decoded once per new picture).
    const hash = this.hashBytes(new Uint8Array(rawArrayBuf));
    const pixelOptions = { crop: productConfig.crop, palette: productConfig.palette, isTransparent, isXBand: station.band === 'X-Band', square: productKey === 'ppi' };
    let still: StillResult | null = null;
    if (!timing && productConfig.stampBox) {
      const stampId = `${station.id}:${productKey}`;
      let entry = this.stampCache.get(stampId);
      if (!entry || entry.hash !== hash) {
        // the one decode serves both: the printed time, and the intensity field used below
        still = await this.processor.still(rawArrayBuf, pixelOptions, productConfig.stampBox);
        entry = { hash, time: still.stamp };
        this.stampCache.set(stampId, entry);
      }
      if (entry.time) {
        const served = sweepHeaderDate && !isNaN(sweepHeaderDate.getTime()) ? sweepHeaderDate.getTime() : Date.now();
        const scanned = stampEpoch(entry.time, served);
        // a time that puts the scan most of a day before the file was copied is a misread digit (the file is copied minutes after a scan): not used
        if (served - scanned < 20 * 3_600_000) timing = radarTimingFromDate(new Date(scanned), 'printed_stamp', false);
      }
    }
    if (!timing && sweepHeaderDate && !isNaN(sweepHeaderDate.getTime())) {
      // Upload time, not the scan time printed on the image: marked as approximate
      timing = radarTimingFromDate(sweepHeaderDate, sweepHeaderIsWriteTime ? 'http_last_modified' : 'http_header', true);
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
    const cacheKey = `${productKey}|${isTransparent}|${hash}`;
    const cacheId = `${station.id}:${productKey}`;
    const cached = this.sweepCache.get(cacheId);
    if (cached && cached.key === cacheKey) {
      if (!cached.result || cached.result.isDisplayed === isDisplayed) return cached.result;
      const updated = { ...cached.result, isDisplayed, timing };
      this.sweepCache.set(cacheId, { key: cacheKey, result: updated });
      return updated;
    }
    still ??= await this.processor.still(rawArrayBuf, pixelOptions);
    let processed: ProcessedRadarResult | null;
    if (still.decoded) {
      processed = still.w < 50 || still.h < 50 ? null : this.buildResult(station, productKey, productConfig, still.w, still.h, still.layoutOk, still.field, timing, isDisplayed, primary);
    } else if (still.bytes) {
      // the GIF reader could not decode it: the browser's own decoder, on the main thread
      processed = await this.decodeAndProcessSweep(station, productKey, productConfig, isTransparent, still.bytes, timing, isDisplayed, primary);
    } else {
      processed = null;
    }
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
    primary = true,
    predecoded: { rgba: Uint8ClampedArray | Uint8Array; w: number; h: number } | null = null
  ): Promise<ProcessedRadarResult | null> {
    const image = predecoded ?? await decodeRadarGif(rawArrayBuf);
    if (!image || image.w < 50 || image.h < 50) return null;
    const { rgba, w, h } = image;
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
    const layoutOk = layoutMatches(productConfig.crop, w, h) && looksLikeRadar(rgba, w, h, productConfig.palette);
    const field = layoutOk
      ? processRadarPixels(rgba, w, h, { crop: productConfig.crop, palette: productConfig.palette, isTransparent, isXBand: station.band === 'X-Band', square: productKey === 'ppi' })
      : null;
    return this.buildResult(station, productKey, productConfig, w, h, layoutOk, field, timing, isDisplayed, live);
  }

  /**
   * The station's result from its intensity field. Layout check: if the image no longer matches the configured crop it is not
   * a radar sweep (IMD swaps in an "under maintenance" photo) or the product layout has changed. Decoding it anyway would
   * paint photo pixels as fake echoes, so the station is treated as offline instead (`live` only: a loop frame does not
   * change the station's online state).
   */
  private buildResult(
    station: RadarStationConfig,
    productKey: RadarProductKey,
    productConfig: RadarStationConfig['products'][RadarProductKey],
    w: number,
    h: number,
    layoutOk: boolean,
    field: Float32Array | null,
    timing: RadarObservationTiming | null,
    isDisplayed: boolean,
    live: boolean
  ): ProcessedRadarResult | null {
    if (live) this.setStationUnavailable(station.id, !layoutOk);
    if (!layoutOk) {
      if (live) {
        console.warn(
          `[RadarService] Station "${station.name}" ${productKey.toUpperCase()} image is ${w}x${h}, ` +
          `which is not a radar sweep (wrong layout, or no legend colours: IMD's "under maintenance" photo). Treating station as offline.`
        );
      }
      return null;
    }
    if (!field) return null;

    const outSize = RADAR_FIELD_SIZE;
    const fieldDataRecord: RadarFieldData = {
      field,
      cropW: outSize,
      cropH: outSize,
      cx: outSize / 2,
      cy: outSize / 2,
      radius: outSize / 2,
      bounds: productConfig.bounds
    };

    return {
      stationId: station.id,
      dataUrl: '', // stations are only shown through the mosaic
      fieldData: fieldDataRecord,
      timing,
      coordinates: productConfig.maplibreCoordinates,
      isDisplayed
    };
  }


  /** Resolution of the composite: 0.5 km per pixel, capped so a phone's GPU can take it. */
  private static readonly MOSAIC_MAX_PX = radarMosaicMaxPx(isPhone());

  /** The mosaic and the nowcast pictures are made in a worker (radar-compute.ts): they took up to a second of a phone's main thread. */
  readonly compute = new RadarCompute();

  /** The mosaic of the radars that are on (with rain aloft see-through), made off the main thread. */
  private composeMosaic(sources: Iterable<[string, ProcessedRadarResult]>, nowMs?: number, product = this.activeProduct()): Promise<ProcessedRadarResult | null> {
    const hidden = this.hiddenStations();
    const shown: MosaicSource[] = [...sources]
      .filter(([id]) => !hidden.has(id))
      .map(([id, r]) => [id, { fieldData: r.fieldData, timing: r.timing, isDisplayed: r.isDisplayed }]);
    return this.compute.compose({ sources: shown, kmPerPx: MOSAIC_KM_PER_PX, maxPx: RadarService.MOSAIC_MAX_PX, product, nowMs });
  }

  /**
   * The stack's mosaic: each station's pictures that are recent enough to draw, as rings inside one another. A picture that is missing or
   * too old leaves its ground to the ring around it (the PPI's to the CAZ, say), so nothing within a station's reach goes blank for it.
   */
  private composeStack(nowMs: number): Promise<ProcessedRadarResult | null> {
    const hidden = this.hiddenStations();
    const results = this.ringResults();
    const sources: MosaicSource[] = [];
    const rings: [string, MosaicRing][] = [];
    for (const station of this.stations) {
      if (hidden.has(station.id)) continue;
      const usable = (p: RadarProductKey) => {
        const r = results.get(ringKey(station.id, p));
        const t = r?.timing?.epochMs;
        return !!r?.fieldData && r.isDisplayed !== false && !(t && nowMs - t > MAX_SCAN_AGE_MIN * 60_000);
      };
      for (const [p, ring] of stackRings(station, usable)) {
        const key = ringKey(station.id, p);
        const r = results.get(key)!;
        sources.push([key, { fieldData: r.fieldData, timing: r.timing, isDisplayed: r.isDisplayed }]);
        rings.push([key, ring]);
      }
    }
    return this.compute.compose({ sources, kmPerPx: MOSAIC_KM_PER_PX, maxPx: RadarService.MOSAIC_MAX_PX, product: 'ppz', nowMs, rings });
  }

  /**
   * How far a station's picture on the map reaches (km): its range for the product on show, or in the stack its outermost ring with a
   * picture (its CAZ's range while it has none yet).
   */
  reachKm(station: RadarStationConfig): number {
    if (!this.stacked()) return station.products[this.activeProduct()]?.rangeKm ?? station.operationalRangeKm;
    const results = this.ringResults();
    const rings = stackRings(station, p => results.has(ringKey(station.id, p)));
    return rings.length > 0 ? station.products[rings[rings.length - 1][0]].rangeKm : station.products.caz?.rangeKm ?? station.operationalRangeKm;
  }

  private composeToken = 0;

  /** Rebuilds the live composite from the latest still of every radar (a newer rebuild started meanwhile wins). */
  private async generateComposite(): Promise<void> {
    const my = ++this.composeToken;
    const res = this.stacked() ? await this.composeStack(Date.now()) : await this.composeMosaic([...this.allRadarResults()], Date.now());
    if (my !== this.composeToken) return;
    this.compositeMosaic.set(res);
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
    const opened: HistoryHandle[] = [];       // the animations opened in the workers, closed at the end
    try {
      // 1. each radar's scans in the last hour: the frames of its animation, plus its live still (IMD updates the
      // animations less often than the stills, so the still is often the newest scan)
      type Scan = { timeMs: number; index: number; res?: ProcessedRadarResult };
      const live = this.allRadarResults();
      const sources = (
        await Promise.all(
          this.stations.map(async station => {
            if (this.unavailableStations().has(station.id) || this.hiddenStations().has(station.id)) return null;
            // only the radars that name an animation download one (a few MB each); the others join the loop with their live pictures
            const file = station.animationFile ? animationFile(station.code, product) : null;
            // The Pallikaranai X-band animations are over 20 MB each, so the loop leaves them out (their live
            // stills are still used).
            const bytes = file && station.band !== 'X-Band' && !station.skipAnimation ? await this.fetchRadarFile(file) : null;
            if (token !== this.historyToken) return null;
            let reader: HistoryHandle | null = null;
            let frames: Scan[] = [];
            if (bytes) {
              try {
                frames = recentFrames(gifFrameTimestamps(bytes));
                if (frames.length > 0) reader = await this.processor.open(bytes);
                if (reader) opened.push(reader);
              } catch {
                reader = null;
                frames = [];
              }
              if (token !== this.historyToken && reader) this.processor.close(reader);
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
      const field = async (src: (typeof sources)[number], scan: Scan): Promise<ProcessedRadarResult | null> => {
        if (scan.res) return scan.res;
        if (!src.reader) return null;
        const key = `${src.station.id}|${scan.timeMs}`;
        if (!decoded.has(key)) {
          const config = src.station.products[product];
          const out = await this.processor.frame(src.reader, scan.index, { crop: config.crop, palette: config.palette, isTransparent, isXBand: src.station.band === 'X-Band', square: product === 'ppi' });
          decoded.set(key, out ? this.buildResult(src.station, product, config, src.reader.width, src.reader.height, out.layoutOk, out.field, null, true, false) : null);
        }
        return decoded.get(key)!;
      };
      const frames: RadarHistoryFrame[] = [];
      for (let k = 0; k < slots.length; k++) {
        const entries: [string, ProcessedRadarResult][] = [];
        for (const src of sources) {
          const scan = scanForSlot(src.frames, slots[k]);
          if (!scan) continue;
          const res = await field(src, scan);
          if (res) entries.push([src.station.id, res]);
          await yieldToBrowser(); // let the page draw between frames
          if (token !== this.historyToken) return;
        }
        // drop decoded scans older than every station's scan for this step (later steps only use newer ones)
        for (const key of [...decoded.keys()]) {
          const [id, t] = key.split('|');
          const src = sources.find(x => x.station.id === id);
          const cur = src && scanForSlot(src.frames, slots[k]);
          if (cur && Number(t) < cur.timeMs) decoded.delete(key);
        }
        const composed = entries.length > 0 ? await this.composeMosaic(entries) : null;
        if (composed?.displayField) {
          frames.push({
            field: composed.displayField,
            fade: composed.displayFade,
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
      for (const h of opened) this.processor.close(h);
      if (token === this.historyToken) this.historyLoading.set(false);
    }
  }

  private async fetchRadarFile(file: string): Promise<Uint8Array | null> {
    for (const url of [`/imd-radar/${file}`, `https://mausam.imd.gov.in/Radar/${file}`]) {
      try {
        // the loop's animations (several MB each) are background work: they must not slow the live pictures down
        const res = await fetch(`${url}?_t=${Math.floor(Date.now() / 60000)}`, { priority: 'low' });
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
    this.leadIndex.set(null);
    this.nowcast.set([]);
    this.replaceHistory([]);
  }

  /** Show a loop frame (or null for live). */
  setPlayIndex(i: number | null): void {
    const n = this.history().length;
    this.leadIndex.set(null);
    this.playIndex.set(i === null || n === 0 ? null : Math.min(Math.max(Math.round(i), 0), n - 1));
  }

  /** Put the radar's clock at a position of the strip: a loop frame, the live picture (the position after the last loop frame) or a nowcast step. */
  setCursor(position: number): void {
    const h = this.history().length;
    const i = Math.min(Math.max(Math.round(position), 0), h + this.nowcast().length);
    if (i < h) {
      this.leadIndex.set(null);
      this.playIndex.set(i);
    } else if (i === h) {
      this.leadIndex.set(null);
      this.playIndex.set(null);
    } else {
      this.playIndex.set(null);
      this.leadIndex.set(i - h - 1);
    }
  }

  /** Play the last hour, the live picture and the nowcast; it holds on the last picture a moment before starting again. */
  async togglePlay(): Promise<void> {
    if (this.playing()) {
      this.pause();
      return;
    }
    if (this.history().length === 0) await this.loadHistory();
    if (this.history().length < 2) return;
    this.playing.set(true);
    let hold = 0;
    if (this.cursor() === this.history().length) this.setCursor(0);
    this.playTimer = setInterval(() => {
      const c = this.cursor();
      if (c >= this.cursorMax()) {
        if (++hold >= 2) {
          hold = 0;
          this.setCursor(0);
        }
        return;
      }
      hold = 0;
      this.setCursor(c + 1);
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


  // the readout under the pointer (see radar-inspector.ts)
  /** Each radar's a of Z = a R^1.6 where the gauges have fitted one (public/data/verification/radar.json, verify_radar.py); empty until then. */
  private readonly zrA = signal<Record<string, number>>({});
  private zrAsked = false;

  private loadRainRates(): void {
    if (this.zrAsked) return;
    this.zrAsked = true;
    fetch('/data/verification/radar.json')
      .then(r => (r.ok ? r.json() : null))
      .then((doc: { zr?: Record<string, { a: number; accepted: boolean }> } | null) => {
        const out: Record<string, number> = {};
        for (const [id, z] of Object.entries(doc?.zr ?? {})) if (z.accepted && z.a > 0) out[id] = z.a;
        this.zrA.set(out);
      })
      .catch(() => (this.zrAsked = false));
  }

  inspectLocation(lat: number, lng: number, screenPoint: { x: number; y: number }): void {
    this.loadRainRates();
    const live = this.liveFrame();
    const frames = live ? [...this.history(), live] : [];
    const input = {
      zrA: this.zrA(),
      lastHourMm: (stationId: string) => (this.playIndex() === null && this.leadIndex() === null ? lastHourRain(frames, lat, lng, this.zrA()[stationId] ?? MARSHALL_PALMER_A) : null),
      shown: this.displayed(),
      allResults: this.allRadarResults(),
      stations: this.stations,
      hidden: this.hiddenStations(),
      // a radar that is down or whose newest picture is over 3 hours old (not drawn on the map either) is left out of the beam list too
      unavailable: new Set([...this.unavailableStations(), ...this.stations.filter(st => this.getStationFreshness(st.id) === 'offline').map(st => st.id)]),
      product: this.coverageProduct(),
    };
    this.hoverInfo.set(inspectRadar(input, lat, lng, screenPoint));
  }

  clearHover(): void {
    this.hoverInfo.set(null);
  }


}
