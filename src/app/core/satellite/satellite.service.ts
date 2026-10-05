import { Injectable, computed, signal } from '@angular/core';
import { mercatorHeight, toOverlayPixels } from './satellite-image';
import {
  SatelliteProduct,
  frameTimes,
  latestFrameTime,
  productForTime,
  satelliteFrameUrl,
} from './satellite.config';

export interface SatelliteFrame {
  timeMs: number;
  product: SatelliteProduct;
  /** Object URL of the finished overlay picture, or null when the satellite had no image for this time (such frames are not listed). */
  url: string | null;
}

const PLAY_INTERVAL_MS = 450;
const REFRESH_MS = 5 * 60_000;
const LOAD_CONCURRENCY = 4;

/**
 * Loads the last three hours of Meteosat-9 pictures, shows them one at a time and can play them as a loop. The picture
 * is HRV by day and infrared at night, chosen per frame. Nothing here needs a key: EUMETView is public.
 */
@Injectable({ providedIn: 'root' })
export class SatelliteService {
  readonly frames = signal<SatelliteFrame[]>([]);
  readonly index = signal(0);
  readonly playing = signal(false);
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly opacity = signal(0.9);

  readonly current = computed<SatelliteFrame | null>(() => this.frames()[this.index()] ?? null);
  /** Minutes between the shown picture and now. */
  readonly ageMinutes = computed(() => {
    const f = this.current();
    return f ? Math.max(0, Math.round((this.now() - f.timeMs) / 60_000)) : null;
  });

  private readonly now = signal(Date.now());
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private loadToken = 0;
  /** Pictures currently held, so their object URLs can be released once they drop out of the window. */
  private retired: SatelliteFrame[] = [];

  /** Start (or resume) fetching; refreshes itself every few minutes while on. */
  activate(): void {
    if (this.refreshTimer === null) this.refreshTimer = setInterval(() => void this.load(), REFRESH_MS);
    if (this.frames().length === 0) void this.load();
  }

  deactivate(): void {
    this.pause();
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async load(): Promise<void> {
    const token = ++this.loadToken;
    const nowMs = Date.now();
    this.now.set(nowMs);
    const times = frameTimes(latestFrameTime(nowMs));
    // keep the pictures we already have for these times (a missing one is tried again), fetch only the rest
    const done = new Map<number, SatelliteFrame>();
    for (const f of this.frames()) if (f.url && times.includes(f.timeMs)) done.set(f.timeMs, f);
    const following = this.index() >= this.frames().length - 1; // watching the newest picture, so keep following it
    this.loading.set(true);
    this.failed.set(false);

    const publish = () => {
      const list = times.map(t => done.get(t)).filter((f): f is SatelliteFrame => !!f?.url); // only pictures that exist
      this.frames.set(list);
      this.index.update(i => (following ? list.length - 1 : Math.min(i, list.length - 1)));
    };
    if (done.size > 0) publish();

    // newest first, a few at a time, so the picture you want appears quickly and the loop fills in behind it
    const queue = times.filter(t => !done.has(t)).reverse();
    const worker = async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
        const frame = await this.loadFrame(t);
        if (token !== this.loadToken) return;
        done.set(t, frame);
        publish();
      }
    };
    await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, worker));
    if (token !== this.loadToken) return; // a newer load took over

    // pictures that have scrolled out of the three-hour window are no longer needed
    for (const f of this.retired) if (f.url && done.get(f.timeMs) !== f) URL.revokeObjectURL(f.url);
    this.retired = [...done.values()];
    publish();
    this.failed.set(this.frames().length === 0);
    this.loading.set(false);
  }

  private async loadFrame(timeMs: number): Promise<SatelliteFrame> {
    const product = productForTime(timeMs);
    try {
      const res = await fetch(satelliteFrameUrl(product, timeMs));
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) throw new Error(`HTTP ${res.status}`);
      const bitmap = await createImageBitmap(await res.blob());
      const { width, height } = bitmap;
      const scratch = new OffscreenCanvas(width, height);
      const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
      sctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const src = sctx.getImageData(0, 0, width, height).data;
      const outHeight = mercatorHeight(width);
      const pixels = toOverlayPixels(src, width, height, product.mode, outHeight);
      const out = new OffscreenCanvas(width, outHeight);
      out.getContext('2d')!.putImageData(new ImageData(pixels, width, outHeight), 0, 0);
      const blob = await out.convertToBlob({ type: 'image/png' });
      return { timeMs, product, url: URL.createObjectURL(blob) };
    } catch {
      return { timeMs, product, url: null };
    }
  }

  setIndex(i: number): void {
    const n = this.frames().length;
    if (n > 0) this.index.set(Math.min(Math.max(Math.round(i), 0), n - 1));
  }

  togglePlay(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  play(): void {
    if (this.playing() || this.frames().length < 2) return;
    this.playing.set(true);
    this.timer = setInterval(() => {
      const n = this.frames().length;
      this.index.update(i => (i + 1) % n);
    }, PLAY_INTERVAL_MS);
  }

  pause(): void {
    this.playing.set(false);
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
