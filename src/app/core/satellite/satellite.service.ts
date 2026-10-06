import { Injectable, computed, signal } from '@angular/core';
import type { SatelliteWorkerRequest, SatelliteWorkerResponse } from './satellite.worker';
import {
  SATELLITE_NATURAL_LAYER,
  SatelliteProduct,
  SatelliteView,
  frameTimes,
  latestFrameTime,
  parseNewestTime,
  productForTime,
  satelliteCapabilitiesUrl,
  satelliteFrameUrl,
} from './satellite.config';

export interface SatelliteFrame {
  timeMs: number;
  product: SatelliteProduct;
  /** Object URL of the finished overlay picture. */
  url: string;
}

/** Time a picture is shown while playing, and the pause on the newest picture before the loop restarts. */
const STEP_MS = 1100;
const HOLD_MS = 1800;
/** How often to ask the service whether a newer picture exists (a tiny request; a picture is fetched only when there is one). */
const CHECK_MS = 2 * 60_000;
const LOAD_CONCURRENCY = 3;

/**
 * Loads the last hour of Meteosat-9 pictures (HRV by day, infrared at night, chosen per frame) and plays them as a
 * loop that fades smoothly from one picture to the next. It asks the service for its newest picture time, so the
 * loop is as recent as the service allows, and checks again every couple of minutes. Nothing here needs a key.
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
  readonly opacity = signal(0.9);
  readonly view = signal<SatelliteView>('picture');

  /** The picture the loop is nearest to. */
  readonly current = computed<SatelliteFrame | null>(() => this.frames()[Math.round(this.position())] ?? null);
  /** Minutes between the shown picture and now. */
  readonly ageMinutes = computed(() => {
    const f = this.current();
    return f ? Math.max(0, Math.round((this.now() - f.timeMs) / 60_000)) : null;
  });

  private readonly now = signal(Date.now());
  private worker: Worker | null = null;
  private nextRequest = 1;
  private readonly pending = new Map<number, (r: SatelliteWorkerResponse) => void>();
  /** The downloaded pictures as served, kept so the view can change without downloading again. */
  private readonly raws = new Map<number, { product: SatelliteProduct; blob: Blob; natural?: Blob }>();
  /** Overlay pictures being built or built, by "view|time". */
  private readonly built = new Map<string, Promise<SatelliteFrame | null>>();
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private raf = 0;
  private loadToken = 0;

  /** Start (or resume) fetching; looks for newer pictures every couple of minutes while on. */
  activate(): void {
    if (this.checkTimer === null) this.checkTimer = setInterval(() => void this.load(), CHECK_MS);
    void this.load();
  }

  deactivate(): void {
    this.pause();
    if (this.checkTimer !== null) clearInterval(this.checkTimer);
    this.checkTimer = null;
    this.loadToken++; // abandon a load in progress
    this.loading.set(false);
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

  async load(): Promise<void> {
    const token = ++this.loadToken;
    const nowMs = Date.now();
    this.now.set(nowMs);
    const newest = await this.newestTime(nowMs);
    if (token !== this.loadToken) return;
    const times = frameTimes(newest);

    const following = this.position() >= this.frames().length - 1; // watching the newest picture, so keep following it
    if (!times.every(t => this.raws.has(t))) this.loading.set(true);
    this.failed.set(false);

    // download what is missing, newest first, a few at a time
    const queue = times.filter(t => !this.raws.has(t)).reverse();
    const worker = async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
        const product = productForTime(t);
        const blob = await this.download(product, t);
        // by day the true-colour picture is fetched too, to be sharpened with the HRV one (the frame still works without it)
        const natural = blob && product.id === 'hrv' ? await this.download(product, t, SATELLITE_NATURAL_LAYER) : null;
        if (token !== this.loadToken) return;
        if (blob) {
          this.raws.set(t, { product, blob, natural: natural ?? undefined });
          await this.publish(times, token, following);
        }
      }
    };
    await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, worker));
    if (token !== this.loadToken) return;

    for (const t of [...this.raws.keys()]) if (!times.includes(t)) this.raws.delete(t); // older than an hour
    await this.publish(times, token, following);
    if (token !== this.loadToken) return;
    this.prune(times);
    this.failed.set(this.frames().length === 0);
    this.loading.set(false);
  }

  private async download(product: SatelliteProduct, timeMs: number, layer?: string): Promise<Blob | null> {
    try {
      const res = await fetch(satelliteFrameUrl(product, timeMs, layer));
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return null;
      return await res.blob();
    } catch {
      return null;
    }
  }

  /**
   * The overlay picture for a downloaded frame in a view, built once and shared: overlapping refreshes must never
   * build the same frame twice, or one would release a picture the map is still showing.
   */
  private frameFor(timeMs: number, view: SatelliteView): Promise<SatelliteFrame | null> {
    const key = `${view}|${timeMs}`;
    let pending = this.built.get(key);
    if (!pending) {
      const raw = this.raws.get(timeMs)!;
      pending = this.process(raw.blob, raw.product, view, view === 'picture' ? raw.natural : undefined).then(url => {
        if (!url) this.built.delete(key); // try again on the next refresh
        return url ? { timeMs, product: raw.product, url } : null;
      });
      this.built.set(key, pending);
    }
    return pending;
  }

  /** Release pictures of other views or of frames that have left the hour. */
  private prune(times: readonly number[]): void {
    const view = this.view();
    for (const [key, pending] of this.built) {
      const [v, t] = key.split('|');
      if (v === view && times.includes(Number(t))) continue;
      this.built.delete(key);
      void pending.then(f => f && URL.revokeObjectURL(f.url));
    }
  }

  /** List the overlay pictures of every downloaded frame, oldest first. */
  private async publish(times: number[], token: number, following: boolean): Promise<void> {
    const view = this.view();
    const built = await Promise.all(times.filter(t => this.raws.has(t)).map(t => this.frameFor(t, view)));
    if (token !== this.loadToken || view !== this.view()) return; // a newer refresh or view took over
    const list = built.filter((f): f is SatelliteFrame => f !== null);
    this.frames.set(list);
    this.position.update(p => (following ? list.length - 1 : Math.min(Math.round(p), list.length - 1)));
  }

  /** Switch between cloud-only and the full picture; the pictures are rebuilt from what is already downloaded. */
  async setView(view: SatelliteView): Promise<void> {
    if (view === this.view()) return;
    this.view.set(view);
    const times = this.frames().map(f => f.timeMs);
    const rebuilt = await Promise.all(times.filter(t => this.raws.has(t)).map(t => this.frameFor(t, view)));
    if (view !== this.view()) return; // changed again while rebuilding
    const list = rebuilt.filter((f): f is SatelliteFrame => f !== null);
    this.frames.set(list);
    this.position.update(p => Math.min(p, Math.max(list.length - 1, 0)));
    this.prune(times);
  }

  /** Overlay picture (object URL) for a downloaded frame, built in a web worker so the map stays smooth. */
  private process(jpeg: Blob, product: SatelliteProduct, view: SatelliteView, natural?: Blob): Promise<string | null> {
    if (typeof Worker === 'undefined') return Promise.resolve(null);
    this.worker ??= this.createWorker();
    const id = this.nextRequest++;
    return new Promise(resolve => {
      this.pending.set(id, r => resolve('png' in r ? URL.createObjectURL(r.png) : null));
      this.worker!.postMessage({ id, jpeg, kind: product.id, view, natural } satisfies SatelliteWorkerRequest);
    });
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
