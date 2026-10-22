import { Injectable, computed, signal } from '@angular/core';
import type { SatelliteWorkerRequest, SatelliteWorkerResponse, SatelliteFlowRequest } from './satellite.worker';
import type { CloudField } from './cloud-field';
import { isPhone } from '../ui/device-profile';
import { readFlag, writeFlag } from '../ui/saved-flag';
import {
  GeoBounds,
  SATELLITE_IR,
  SatelliteProduct,
  frameTimes,
  isTwilightTime,
  latestFrameTime,
  parseNewestTime,
  productForTime,
  satelliteCapabilitiesUrl,
  satelliteFrameUrl,
} from './satellite.config';
import { LUMA_GRID_SIZE, SatelliteHoverReading, sampleLumaGrid } from './satellite-image';
import type { FlowField, MotionGrid } from './satellite-flow';

/** One picture of the loop to fetch. */
interface PlanItem {
  timeMs: number;
  product: SatelliteProduct;
  rawKey: string;
  fetch: () => Promise<{ blob: Blob; twilightIr?: Blob } | null>;
}

export interface SatelliteFrame {
  timeMs: number;
  product: SatelliteProduct;
  /** Object URL of the finished overlay picture. */
  url: string;
  /** Compact IR brightness grid for instant Cloud-Top Temperature & Height hover readout. */
  lumaGrid?: Uint8Array;
  /** How much cloud is where, for the loop's motion between pictures (satellite-flow.ts). */
  motion?: MotionGrid;
  /** The clouds' cover, top and base heights and thickness on a coarse grid, for the 3D view (cloud-field.ts). */
  cloudField?: CloudField;
}

/**
 * Measured brightness temperatures of the frames, for the 3D clouds, published by the satellite workflow of gowthamgta/atmos-satellite: Meteosat's (pipeline/satellite_bt.py)
 * first, then Himawari-9's (himawari_bt.py: seen slantwise, parallax-corrected, empty over the west of India).
 */
const BT_SOURCES = [
  // served by GitHub Pages from their own repository (gowthamgta/atmos-satellite), so nothing piles up in this one's history
  ...['bt/', 'bt-h9/'].map(folder => 'https://gowthamgta.github.io/atmos-satellite/' + folder),
  // the branch they were first published to, until the new home is running
  ...['bt/', 'bt-h9/'].map(folder => 'https://raw.githubusercontent.com/gowthamgta/Atmos/satellite-data/' + folder),
];
/** A temperature frame counts for a picture within this much of its time. */
const BT_MATCH_MS = 8 * 60_000;

/** Time a picture is shown while playing, and the pause on the newest picture before the loop restarts. */
const STEP_MS = 1100;
const HOLD_MS = 1800;
/** How often to ask the service whether a newer picture exists (a tiny request; a picture is fetched only when there is one). */
const CHECK_MS = 2 * 60_000;
const LOAD_CONCURRENCY = 5;
/** The newest picture of each channel is kept in the browser's cache, to be shown at once next time (EUMETView itself takes 2 to 3 seconds). */
const CACHE_NAME = 'atmos-satellite-v1';
/** A kept picture older than this is not worth showing first. */
const CACHED_MAX_AGE_MS = 3 * 3_600_000;

/**
 * Loads the last hour of Meteosat-9 pictures (the HRV by day, one infrared picture by night) and plays them as a loop that
 * fades smoothly from one picture to the next. It asks the service for its newest picture time, so the loop is as recent as
 * the service allows, and checks again every couple of minutes. Nothing here needs a key.
 */
@Injectable({ providedIn: 'root' })
export class SatelliteService {
  readonly frames = signal<SatelliteFrame[]>([]);
  /**
   * The cloud motion from each frame to the next (null where it is not worked out yet, or the two are of different channels), so the loop shows
   * the clouds moving between pictures (see satellite-flow.ts). Worked out in the worker once per pair.
   */
  readonly flows = signal<(FlowField | null)[]>([]);
  private readonly flowCache = new Map<string, Promise<FlowField | null>>();
  /**
   * Where the loop is, as a frame number with a fraction: 2.4 is 40% of the way from the third picture to the fourth.
   * It only has a fraction while playing; otherwise it sits on a whole number.
   */
  readonly position = signal(0);
  readonly playing = signal(false);
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly opacity = signal(1);
  readonly hoverReading = signal<SatelliteHoverReading | null>(null);
  /** The older pictures of the hour are only downloaded once the loop is wanted (play, step back, the slider): first only the newest. */
  readonly historyRequested = signal(false);
  /** The satellite layer is on (the pictures are being kept fresh). */
  readonly active = signal(false);
  /** Show the infrared picture also by day (the switch in the panel); off: the visible HRV by day, infrared at night. */
  readonly infraredOnly = signal(readFlag('atmosiq.satellite.infrared', false));
  /** The clouds drawn in 3D at their heights over a tilted map (rendering/cloud-volume.layer.ts) instead of the flat picture. */
  readonly threeD = signal(readFlag('atmosiq.satellite.3d', false));
  /** How much the 3D view stretches heights: 1 is true scale (a 16 km storm is a sliver at country zoom), 3 or 6 make height readable. */
  readonly heightScale = signal(readHeightScale());

  /** The picture the loop is nearest to. */
  readonly current = computed<SatelliteFrame | null>(() => this.frames()[Math.round(this.position())] ?? null);
  /** Minutes between the shown picture and now. */
  readonly ageMinutes = computed(() => {
    const f = this.current();
    return f ? Math.max(0, Math.round((this.now() - f.timeMs) / 60_000)) : null;
  });

  private readonly now = signal(Date.now());
  private workers: Worker[] = [];
  private turn = 0;
  private nextRequest = 1;
  private readonly pending = new Map<number, (r: SatelliteWorkerResponse) => void>();
  /** The downloaded pictures as served, keyed by "channel|timeMs". */
  private readonly raws = new Map<string, { timeMs: number; product: SatelliteProduct; blob: Blob; twilightIr?: Blob; lumaGrid?: Uint8Array }>();
  /** Overlay pictures being built or built, by "channel|timeMs". */
  private readonly built = new Map<string, Promise<SatelliteFrame | null>>();
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private raf = 0;
  private loadToken = 0;
  /**
   * The newest picture time the service last reported (0: not asked yet, or it did not answer). The loop ends there, even when that is
   * older than the clock's guess: EUMETView sometimes runs hours behind, and asks for pictures it does not have yet only get 502s.
   */
  private knownNewest = 0;
  /** The picture kept from last time, shown until the fresh newest one is built. */
  private preview: SatelliteFrame | null = null;
  private playWhenReady = false;
  private publishSeq = 0;
  private publishApplied = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHoverCoords: { lat: number; lon: number } | null = null;

  /** Switch between the visible picture (by day) and the infrared; the loop is rebuilt from the other channel. */
  setInfrared(on: boolean): void {
    if (this.infraredOnly() === on) return;
    this.infraredOnly.set(on);
    writeFlag('atmosiq.satellite.infrared', on);
    if (this.active()) void this.load();
  }

  setThreeD(on: boolean): void {
    this.threeD.set(on);
    writeFlag('atmosiq.satellite.3d', on);
  }

  setHeightScale(scale: number): void {
    this.heightScale.set(scale);
    try {
      localStorage.setItem('atmosiq.satellite.heightScale', String(scale));
    } catch {
      // not remembered
    }
  }

  /** Start (or resume) fetching; looks for newer pictures every couple of minutes while on. */
  activate(): void {
    this.active.set(true);
    if (this.checkTimer === null) this.checkTimer = setInterval(() => void this.load(), CHECK_MS);
    void this.load();
  }

  deactivate(): void {
    this.active.set(false);
    this.pause();
    this.clearHover();
    if (this.checkTimer !== null) clearInterval(this.checkTimer);
    this.checkTimer = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.loadToken++; // abandon a load in progress
    this.loading.set(false);
    this.historyRequested.set(false);
    this.playWhenReady = false;
    if (this.preview) URL.revokeObjectURL(this.preview.url);
    this.preview = null;
  }

  /** Sample Cloud-Top Temperature (°C) and Height (km) at `(lat, lon)` for the currently displayed frame. */
  inspectAt(lat: number, lon: number): void {
    this.lastHoverCoords = { lat, lon };
    const f = this.current();
    const grid = f?.lumaGrid ?? (f ? this.raws.get(`${f.product.id}|${f.timeMs}`)?.lumaGrid : undefined);
    if (!grid) {
      this.hoverReading.set(null);
      return;
    }
    this.hoverReading.set(sampleLumaGrid(grid, LUMA_GRID_SIZE, lat, lon));
  }

  clearHover(): void {
    this.lastHoverCoords = null;
    if (this.hoverReading() !== null) this.hoverReading.set(null);
  }

  /** Newest picture time the service has, or null when it cannot be asked (or gives a time in the future or many hours old). */
  private async newestTime(nowMs: number): Promise<number | null> {
    try {
      // both layers are updated together, so either one says how recent the data is
      const res = await fetch(satelliteCapabilitiesUrl(productForTime(latestFrameTime(nowMs))));
      if (!res.ok) return null;
      const newest = parseNewestTime(await res.text());
      return newest !== null && newest <= nowMs && nowMs - newest < 6 * 3_600_000 ? newest : null;
    } catch {
      return null;
    }
  }

  /**
   * What to show: the frames of the last hour, oldest first, each with a way to fetch it. The times come from the service's
   * newest time and the picture from EUMETView (during dawn and dusk also the infrared picture, so the solar terminator
   * blends smoothly without a dark band).
   */
  private plan(newest: number): PlanItem[] {
    return frameTimes(newest).map(t => {
      const product = this.infraredOnly() ? SATELLITE_IR : productForTime(t);
      const rawKey = `${product.id}|${t}`;
      const needTwilightIr = product.id === 'hrv' && isTwilightTime(t);
      return {
        timeMs: t,
        product,
        rawKey,
        fetch: async () => {
          const [blob, twilightIr] = await Promise.all([
            this.download(product, t),
            needTwilightIr ? this.download(SATELLITE_IR, t) : Promise.resolve(null),
          ]);
          return blob ? { blob, twilightIr: twilightIr ?? undefined } : null;
        },
      };
    });
  }

  async load(): Promise<void> {
    const token = ++this.loadToken;
    const nowMs = Date.now();
    this.now.set(nowMs);
    // Start at once from the newest time the service gave last time (or, before it has answered, the one the clock says is safe): asking
    // the service takes a second on its own, so it is asked alongside, and when its newest picture is another one (newer, or older because
    // the service is running late) the loop is planned again around it.
    const startAt = this.knownNewest > 0 ? this.knownNewest : latestFrameTime(nowMs);
    const plan = this.plan(startAt);
    void this.newestTime(nowMs).then(newest => {
      if (token !== this.loadToken || newest === null) return;
      this.knownNewest = newest;
      if (newest !== startAt) void this.load();
    });
    const rawKeys = plan.map(p => p.rawKey);
    // first only the newest picture; the rest of the hour once the loop is wanted
    const wanted = this.historyRequested() ? plan : plan.slice(-1);
    const wantedKeys = wanted.map(p => p.rawKey);
    void this.showCached(plan[plan.length - 1].product, token);

    const following = this.position() >= this.frames().length - 1; // watching the newest picture, so keep following it
    if (!wantedKeys.every(k => this.raws.has(k))) this.loading.set(true);
    this.failed.set(false);

    // download what is missing, newest first, a few at a time
    const queue = wanted.filter(p => !this.raws.has(p.rawKey)).reverse();
    const worker = async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        const got = await item.fetch();
        if (token !== this.loadToken) return;
        if (got) {
          this.raws.set(item.rawKey, { timeMs: item.timeMs, product: item.product, blob: got.blob, twilightIr: got.twilightIr });
          if (item === plan[plan.length - 1]) void this.keepForNextTime(item, got.blob);
          void this.publish(plan, token, following); // the next picture downloads while this one is built
        }
      }
    };
    await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, worker));
    if (token !== this.loadToken) return;

    for (const [k, v] of [...this.raws.entries()]) {
      if (!rawKeys.includes(k)) this.raws.delete(k); // older than the loop, or of the channel not shown now
    }
    await this.publish(plan, token, following);
    if (token !== this.loadToken) return;
    this.prune(rawKeys);
    this.failed.set(this.frames().length === 0);
    this.loading.set(false);
    // some pictures could not be fetched (the service was busy): ask again in a little while instead of at the next check
    if (this.playWhenReady && this.frames().length >= 2) {
      this.playWhenReady = false;
      this.play();
    }
    if (this.retryTimer === null && wantedKeys.some(k => !this.raws.has(k))) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.load();
      }, 20_000);
    }
  }

  /** The newest picture of a channel, kept for the next visit (a failure only means nothing is kept). */
  private async keepForNextTime(item: PlanItem, blob: Blob): Promise<void> {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(new Request(`/__satellite/${item.product.id}`), new Response(blob, { headers: { 'x-time': String(item.timeMs), 'content-type': 'image/jpeg' } }));
    } catch {
      // no cache in this browser or window: the next visit simply waits for the service
    }
  }

  /** Shows the picture kept from last time at once (built in the worker, well under a second), until the fresh one is ready. */
  private async showCached(product: SatelliteProduct, token: number): Promise<void> {
    const stale = () => token !== this.loadToken || this.frames().length > 0;
    try {
      if (stale() || typeof caches === 'undefined') return;
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(new Request(`/__satellite/${product.id}`));
      if (!hit || stale()) return;
      const timeMs = Number(hit.headers.get('x-time'));
      if (!timeMs || Date.now() - timeMs > CACHED_MAX_AGE_MS) return;
      const res = await this.process(await hit.blob(), product, undefined, timeMs);
      if (!res) return;
      if (stale()) {
        URL.revokeObjectURL(res.url);
        return;
      }
      this.preview = { timeMs, product, url: res.url, lumaGrid: res.lumaGrid, motion: res.motion, cloudField: res.cloudField };
      this.frames.set([this.preview]);
      this.position.set(0);
    } catch {
      // nothing usable kept: wait for the service
    }
  }

  /** Download the rest of the hour (play, step back and the slider need it); the newest picture is already there. */
  requestHistory(): void {
    if (this.historyRequested()) return;
    this.historyRequested.set(true);
    if (this.active()) void this.load();
  }

  /** A picture, or null. EUMETView sometimes answers a busy moment with a 500: that is tried once more after a short wait. */
  async downloadUrl(url: string): Promise<Blob | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url);
        if (res.ok && (res.headers.get('content-type') ?? '').startsWith('image/')) return await res.blob();
        if (res.status < 500) return null;
      } catch {
        // the network, not the service: try again too
      }
      if (attempt === 0) await new Promise(r => setTimeout(r, 900));
    }
    return null;
  }

  private async download(product: SatelliteProduct, timeMs: number): Promise<Blob | null> {
    return this.downloadUrl(satelliteFrameUrl(product, timeMs));
  }

  /**
   * The overlay picture for a downloaded frame, built once and shared: overlapping refreshes must never build the same
   * frame twice, or one would release a picture the map is still showing.
   */
  private frameFor(rawKey: string): Promise<SatelliteFrame | null> {
    let pending = this.built.get(rawKey);
    if (!pending) {
      const raw = this.raws.get(rawKey)!;
      pending = this.process(raw.blob, raw.product, raw.twilightIr, raw.timeMs).then(res => {
        if (!res) {
          this.built.delete(rawKey); // try again on the next refresh
          return null;
        }
        if (res.lumaGrid) raw.lumaGrid = res.lumaGrid;
        return { timeMs: raw.timeMs, product: raw.product, url: res.url, lumaGrid: raw.lumaGrid, motion: res.motion, cloudField: res.cloudField };
      });
      this.built.set(rawKey, pending);
    }
    return pending;
  }

  /** Release the pictures of frames that have left the hour. */
  private prune(activeRawKeys: readonly string[]): void {
    for (const [key, pending] of this.built) {
      if (activeRawKeys.includes(key)) continue;
      this.built.delete(key);
      void pending.then(f => f && URL.revokeObjectURL(f.url));
    }
  }

  /** List the overlay pictures of every downloaded frame, oldest first. */
  private async publish(plan: readonly PlanItem[], token: number, following: boolean): Promise<void> {
    const seq = ++this.publishSeq;
    const built = await Promise.all(plan.filter(p => this.raws.has(p.rawKey)).map(p => this.frameFor(p.rawKey)));
    if (token !== this.loadToken) return; // a newer refresh took over
    if (seq < this.publishApplied) return; // a later publish (with more pictures) is already shown
    this.publishApplied = seq;
    const list = built.filter((f): f is SatelliteFrame => f !== null);
    if (list.length === 0 && this.preview) return; // keep the small first picture until a full one is built
    this.frames.set(list);
    void this.updateFlows(list);
    if (this.preview) {
      const old = this.preview;
      this.preview = null;
      setTimeout(() => URL.revokeObjectURL(old.url), 5000);
    }
    this.position.update(p => (following ? list.length - 1 : Math.min(Math.round(p), list.length - 1)));
    if (this.lastHoverCoords) this.inspectAt(this.lastHoverCoords.lat, this.lastHoverCoords.lon);
  }

  /**
   * Overlay picture (object URL) and downsampled luma grid for a downloaded frame, built in a web worker (a closer window's
   * pictures are built here too, with the box they cover).
   */
  process(
    jpeg: Blob,
    product: SatelliteProduct,
    twilightIr?: Blob,
    timeMs?: number,
    bounds?: GeoBounds,
    lossless = false,
  ): Promise<{ url: string; lumaGrid?: Uint8Array; motion?: MotionGrid; cloudField?: CloudField } | null> {
    if (typeof Worker === 'undefined') return Promise.resolve(null);
    if (this.workers.length === 0) this.workers = Array.from({ length: SatelliteService.poolSize() }, () => this.createWorker());
    const worker = this.workers[this.turn++ % this.workers.length];
    const id = this.nextRequest++;
    const btPending = bounds || timeMs === undefined ? Promise.resolve(undefined) : this.brightnessFor(timeMs);
    return btPending.then(bt => new Promise(resolve => {
      this.pending.set(id, r => resolve('png' in r ? { url: URL.createObjectURL(r.png), lumaGrid: r.lumaGrid, motion: r.motion, cloudField: r.cloudField } : null));
      worker.postMessage({ id, jpeg, kind: product.id, twilightIr, timeMs, bounds, lossless, bt } satisfies SatelliteWorkerRequest);
    }));
  }

  private btIndexes: { at: number; sources: { frames: { timeMs: number; url: string }[]; offsetK: number; stepK: number }[] } | null = null;
  private btLoading: Promise<void> | null = null;

  /** The measured temperatures for a picture's time, if the satellite workflow has them (its indexes are looked at every few minutes). */
  private async brightnessFor(timeMs: number): Promise<{ url: string; offsetK: number; stepK: number } | undefined> {
    if (!this.btIndexes || Date.now() - this.btIndexes.at > 4 * 60_000) {
      this.btLoading ??= Promise.all(BT_SOURCES.map(base => fetch(base + 'index.json', { cache: 'no-cache' })
        .then(r => (r.ok ? r.json() : null))
        .then((j: { frames?: { time: string; file: string }[]; offsetK?: number; stepK?: number } | null) => ({
          frames: (j?.frames ?? []).map(f => ({ timeMs: Date.parse(f.time), url: base + f.file })).filter(f => Number.isFinite(f.timeMs)),
          offsetK: j?.offsetK ?? 180,
          stepK: j?.stepK ?? 0.5,
        }))
        .catch(() => ({ frames: [], offsetK: 180, stepK: 0.5 }))))
        .then(sources => {
          this.btIndexes = { at: Date.now(), sources };
        })
        .finally(() => (this.btLoading = null));
      await this.btLoading;
    }
    for (const src of this.btIndexes?.sources ?? []) {
      const best = src.frames.reduce<{ timeMs: number; url: string } | null>((m, f) => (!m || Math.abs(f.timeMs - timeMs) < Math.abs(m.timeMs - timeMs) ? f : m), null);
      if (best && Math.abs(best.timeMs - timeMs) <= BT_MATCH_MS) return { url: best.url, offsetK: src.offsetK, stepK: src.stepK };
    }
    return undefined;
  }

  /** The motion between each frame and the next, worked out once per pair; the list is set again as each one arrives. */
  private async updateFlows(list: readonly SatelliteFrame[]): Promise<void> {
    const keyOf = (i: number) => `${list[i].url}|${list[i + 1].url}`;
    const show = () => {
      if (this.frames() !== list) return; // the loop changed meanwhile: its own update takes over
      this.flows.set(list.map((_, i) => (i + 1 < list.length ? this.flowDone.get(keyOf(i)) ?? null : null)));
    };
    show();
    for (const key of [...this.flowCache.keys()]) if (!list.some((_, i) => i + 1 < list.length && keyOf(i) === key)) { this.flowCache.delete(key); this.flowDone.delete(key); }
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (!a.motion || !b.motion || a.product.id !== b.product.id) continue;
      const key = keyOf(i);
      if (!this.flowCache.has(key)) this.flowCache.set(key, this.flowBetween(a.motion, b.motion));
      const field = await this.flowCache.get(key)!;
      if (field) this.flowDone.set(key, field);
      show();
    }
  }
  private readonly flowDone = new Map<string, FlowField>();

  private flowBetween(a: MotionGrid, b: MotionGrid): Promise<FlowField | null> {
    if (typeof Worker === 'undefined') return Promise.resolve(null);
    if (this.workers.length === 0) this.workers = Array.from({ length: SatelliteService.poolSize() }, () => this.createWorker());
    const worker = this.workers[this.turn++ % this.workers.length];
    const id = this.nextRequest++;
    return new Promise(resolve => {
      this.pending.set(id, r => resolve('field' in r ? r.field : null));
      worker.postMessage({ id, flow: { a, b } } satisfies SatelliteFlowRequest);
    });
  }

  /**
   * Frames are built one per worker at a time. A desktop with cores to spare builds two at once (about twice as fast, at
   * the cost of a second frame's working memory); a phone builds them one by one.
   */
  private static poolSize(): number {
    const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
    return !isPhone() && cores >= 6 ? 2 : 1;
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL('./satellite.worker', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<SatelliteWorkerResponse>) => {
      const done = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      done?.(e.data);
    };
    return worker;
  }

  /** Jump to a whole frame (the slider). */
  setFrame(i: number): void {
    if (i < this.frames().length - 1) this.requestHistory();
    const n = this.frames().length;
    if (n > 0) this.position.set(Math.min(Math.max(Math.round(i), 0), n - 1));
  }

  /** Step forward or back by delta frames (delta: -1 or +1), pausing the loop. */
  step(delta: number): void {
    this.pause();
    this.requestHistory();
    const n = this.frames().length;
    if (n === 0) return;
    const cur = Math.round(this.position());
    this.setFrame(cur + delta);
  }

  togglePlay(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  /** Play the hour as a loop: each picture fades into the next, the newest holds a moment, then it starts again. */
  play(): void {
    if (this.playing()) return;
    if (this.frames().length < 2) {
      // only the newest picture is loaded so far: fetch the hour, and start the loop when it is all there
      if (!this.historyRequested()) {
        this.playWhenReady = true;
        this.requestHistory();
      }
      return;
    }
    if (typeof requestAnimationFrame !== 'function') return;
    this.playing.set(true);
    if (this.position() >= this.frames().length - 1) this.position.set(0);
    let last = performance.now();
    let hold = 0;
    const tick = (now: number) => {
      if (!this.playing()) return;
      const dt = Math.min(now - last, 100); // ignore long pauses (hidden tab)
      last = now;
      const top = this.frames().length - 1;
      if (hold > 0) {
        hold -= dt;
        if (hold <= 0) this.position.set(0);
      } else {
        const p = this.position() + dt / STEP_MS;
        if (p >= top) {
          this.position.set(top);
          hold = HOLD_MS;
        } else {
          this.position.set(p);
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing.set(false);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.position.update(p => Math.round(p));
  }
}

/** The 3D view's height scale as last chosen (3 unless 1 or 6 was picked). */
function readHeightScale(): number {
  try {
    const v = Number(localStorage.getItem('atmosiq.satellite.heightScale'));
    return v === 1 || v === 3 || v === 6 ? v : 3;
  } catch {
    return 3;
  }
}
