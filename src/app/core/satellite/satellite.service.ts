import { Injectable, computed, signal } from '@angular/core';
import type { SatelliteWorkerRequest, SatelliteWorkerResponse } from './satellite.worker';
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
}

/** Time a picture is shown while playing, and the pause on the newest picture before the loop restarts. */
const STEP_MS = 1100;
const HOLD_MS = 1800;
/** How often to ask the service whether a newer picture exists (a tiny request; a picture is fetched only when there is one). */
const CHECK_MS = 2 * 60_000;
const LOAD_CONCURRENCY = 5;

/**
 * Loads the last hour of Meteosat-9 pictures (the HRV by day, one infrared picture by night) and plays them as a loop that
 * fades smoothly from one picture to the next. It asks the service for its newest picture time, so the loop is as recent as
 * the service allows, and checks again every couple of minutes. Nothing here needs a key.
 */
@Injectable({ providedIn: 'root' })
export class SatelliteService {
  readonly frames = signal<SatelliteFrame[]>([]);
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
  /** The satellite layer is on (the pictures are being kept fresh). */
  readonly active = signal(false);
  /** Show the infrared picture also by day (the switch in the panel); off: the visible HRV by day, infrared at night. */
  readonly infraredOnly = signal(readFlag('atmosiq.satellite.infrared', false));

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
  /** The newest picture time the service has reported so far (0: not asked yet). */
  private knownNewest = 0;
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

  /** Newest picture time the service has, or a guess from the clock when it cannot be asked. */
  private async newestTime(nowMs: number): Promise<number> {
    const fallback = latestFrameTime(nowMs);
    try {
      // both layers are updated together, so either one says how recent the data is
      const res = await fetch(satelliteCapabilitiesUrl(productForTime(fallback)));
      if (!res.ok) return fallback;
      const newest = parseNewestTime(await res.text());
      // never trust a time in the future or one that is hours old
      return newest !== null && newest <= nowMs && nowMs - newest < 6 * 3_600_000 ? newest : fallback;
    } catch {
      return fallback;
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
    // Start at once from the newest time the clock says is safe (or the one the service gave last time): asking the service for its
    // newest time takes a second on its own, so it is asked alongside, and a newer picture, if there is one, is loaded when it answers.
    const startAt = Math.max(latestFrameTime(nowMs), this.knownNewest);
    const plan = this.plan(startAt);
    void this.newestTime(nowMs).then(newest => {
      if (token !== this.loadToken) return;
      this.knownNewest = Math.max(this.knownNewest, newest);
      if (newest > startAt) void this.load();
    });
    const rawKeys = plan.map(p => p.rawKey);
    const times = plan.map(p => p.timeMs);

    const following = this.position() >= this.frames().length - 1; // watching the newest picture, so keep following it
    if (!rawKeys.every(k => this.raws.has(k))) this.loading.set(true);
    this.failed.set(false);

    // download what is missing, newest first, a few at a time
    const queue = plan.filter(p => !this.raws.has(p.rawKey)).reverse();
    const worker = async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        const got = await item.fetch();
        if (token !== this.loadToken) return;
        if (got) {
          this.raws.set(item.rawKey, { timeMs: item.timeMs, product: item.product, blob: got.blob, twilightIr: got.twilightIr });
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
    if (this.retryTimer === null && rawKeys.some(k => !this.raws.has(k))) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.load();
      }, 20_000);
    }
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
        return { timeMs: raw.timeMs, product: raw.product, url: res.url, lumaGrid: raw.lumaGrid };
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
    this.frames.set(list);
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
  ): Promise<{ url: string; lumaGrid?: Uint8Array } | null> {
    if (typeof Worker === 'undefined') return Promise.resolve(null);
    if (this.workers.length === 0) this.workers = Array.from({ length: SatelliteService.poolSize() }, () => this.createWorker());
    const worker = this.workers[this.turn++ % this.workers.length];
    const id = this.nextRequest++;
    return new Promise(resolve => {
      this.pending.set(id, r => resolve('png' in r ? { url: URL.createObjectURL(r.png), lumaGrid: r.lumaGrid } : null));
      worker.postMessage({ id, jpeg, kind: product.id, twilightIr, timeMs, bounds, lossless } satisfies SatelliteWorkerRequest);
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
    const n = this.frames().length;
    if (n > 0) this.position.set(Math.min(Math.max(Math.round(i), 0), n - 1));
  }

  /** Step forward or back by delta frames (delta: -1 or +1), pausing the loop. */
  step(delta: number): void {
    this.pause();
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
    if (this.playing() || this.frames().length < 2 || typeof requestAnimationFrame !== 'function') return;
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
