import { Injectable, InjectionToken, effect, inject, signal, untracked } from '@angular/core';
import { isPhone } from '../ui/device-profile';
import {
  SATELLITE_BOUNDS,
  SATELLITE_IR,
  SATELLITE_SIZE,
  SatelliteProduct,
  isTwilightTime,
  satelliteFrameUrl,
} from './satellite.config';
import { SatelliteFrame, SatelliteService } from './satellite.service';
import { MapView, SatelliteWindow, WINDOW_LOSSLESS_MAX_PX, WindowLimits, chooseWindow, kmPerPixel } from './satellite-window';

/** The closer window the map draws over the whole-India picture, with one picture for each frame of the main loop. */
export interface ShownWindow {
  window: SatelliteWindow;
  /** The times of the frames, to be matched against the main loop's (a frame with no closer picture is null). */
  times: number[];
  frames: (SatelliteFrame | null)[];
}

/** A window's pictures as EUMETView sent them. */
interface WindowRaw {
  blob: Blob;
  twilightIr?: Blob;
  /** The picture came as a PNG, so it has no JPEG blocks to smooth. */
  lossless: boolean;
}

interface Item {
  timeMs: number;
  product: SatelliteProduct;
  rawKey: string;
}

/** What a window may be, set once from the device: the biggest picture to ask for, and how fine the whole-India picture already is. */
export const SATELLITE_WINDOW_LIMITS = new InjectionToken<WindowLimits>('SATELLITE_WINDOW_LIMITS', {
  providedIn: 'root',
  factory: () => ({ maxPx: isPhone() ? 1280 : 2800, globalKmPerPx: kmPerPixel(SATELLITE_BOUNDS, SATELLITE_SIZE.width) }),
});

const DOWNLOAD_CONCURRENCY = 3;
/** Windows whose downloads are kept, so going back to a place does not fetch it again. */
const KEEP_WINDOWS = 3;
/** The wait after the map or the loop changes before the window is looked at again (a pinch or a fling makes many changes). */
const SETTLE_MS = 250;

/**
 * The closer pictures of the satellite loop. A phone's whole-India picture has 3 km pixels, but the high-resolution visible channel
 * is built from pixels about 1.3 km wide, so when the map is zoomed in a window of the same pictures at that pixel is fetched for
 * the part of the map in view (see satellite-window.ts for how it is chosen) and the map draws it over the main picture. A small
 * window comes as a lossless PNG, so the service's hard JPEG does not show its blocks when it is magnified.
 *
 * It follows the main loop: one picture per frame, the same times, built in the same worker. Only the HRV by day has anything
 * finer to give; the infrared picture of the night is 4 to 6 km a pixel, no finer than the main picture, so by night there is
 * no window.
 */
@Injectable({ providedIn: 'root' })
export class SatelliteDetailService {
  private readonly sat = inject(SatelliteService);
  private readonly limits = inject(SATELLITE_WINDOW_LIMITS);

  /** What to draw over the main picture (null: nothing, the main picture is fine or the window is not ready). */
  readonly shown = signal<ShownWindow | null>(null);
  /** Whether a detail window is currently being fetched or built. */
  readonly loading = signal<boolean>(false);

  private view: MapView | null = null;
  private wanted: SatelliteWindow | null = null;
  private readonly raws = new Map<string, WindowRaw>();
  private readonly windowsUsed: string[] = [];
  private readonly built = new Map<string, Promise<SatelliteFrame | null>>();
  private token = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      // whatever changes which closer pictures are wanted: the main loop, whether it is on
      this.sat.frames();
      this.sat.active();
      this.sat.loading();
      untracked(() => this.schedule());
    });
  }

  /** The map says where it is looking; called when it stops moving and when it changes size. */
  setView(view: MapView): void {
    this.view = view;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, SETTLE_MS);
  }

  private clear(): void {
    this.wanted = null;
    if (this.shown() !== null) this.shown.set(null);
    this.loading.set(false);
    this.prune(null);
  }

  private async refresh(): Promise<void> {
    const token = ++this.token;
    const main = this.sat.frames();
    const view = this.view;
    if (!this.sat.active() || !view || main.length === 0) {
      this.clear();
      return;
    }
    if (this.sat.loading()) return; // the whole-India pictures first; this runs again when they are in
    const win = chooseWindow(view, this.limits, this.wanted);
    this.wanted = win;
    const items: Item[] = main.map(f => ({ timeMs: f.timeMs, product: f.product, rawKey: `${win?.id}|${f.product.id}|${f.timeMs}` }));
    const hrv = items.filter(i => i.product.id === 'hrv');
    if (!win || hrv.length === 0) {
      this.clear();
      return;
    }
    this.useWindow(win.id);

    this.loading.set(true);
    try {
      // download what is missing, newest first, a few at a time
      const queue = hrv.filter(i => !this.raws.has(i.rawKey)).reverse();
      const worker = async () => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
          const got = await this.download(win, item);
          if (token !== this.token) return;
          if (got) this.raws.set(item.rawKey, got);
        }
      };
      await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) }, worker));
      if (token !== this.token) return;

      const frames = await Promise.all(items.map(i => (this.raws.has(i.rawKey) ? this.frameFor(win, i) : Promise.resolve(null))));
      if (token !== this.token) return; // the map moved on while these were being built
      this.shown.set({ window: win, times: items.map(i => i.timeMs), frames });
      this.prune(win);
    } finally {
      if (token === this.token) {
        this.loading.set(false);
      }
    }
  }

  /** Note that a window is in use, and drop the downloads of the ones used longest ago. */
  private useWindow(id: string): void {
    const at = this.windowsUsed.indexOf(id);
    if (at >= 0) this.windowsUsed.splice(at, 1);
    this.windowsUsed.push(id);
    while (this.windowsUsed.length > KEEP_WINDOWS) {
      const old = this.windowsUsed.shift()!;
      for (const key of [...this.raws.keys()]) if (key.startsWith(`${old}|`)) this.raws.delete(key);
    }
  }

  private async download(win: SatelliteWindow, item: Item): Promise<WindowRaw | null> {
    const half = { width: Math.max(64, Math.round(win.size.width / 2)), height: Math.max(64, Math.round(win.size.height / 2)) };
    const url = (product: SatelliteProduct, size: { width: number; height: number }, lossless = false) =>
      satelliteFrameUrl(product, item.timeMs, product.layer, size, win.bounds, lossless);
    // a small window is magnified a lot, where the service's hard JPEG shows its blocks: that one is asked for as a PNG (and as a
    // JPEG if the service cannot make it). The infrared picture's pixels are 4-6 km: half the pixels of the HRV's hold all it has.
    const wantLossless = win.size.width * win.size.height <= WINDOW_LOSSLESS_MAX_PX;
    const [hrv, twilightIr] = await Promise.all([
      (async () => {
        const png = wantLossless ? await this.sat.downloadUrl(url(item.product, win.size, true)) : null;
        if (png) return { blob: png, lossless: true };
        const jpeg = await this.sat.downloadUrl(url(item.product, win.size));
        return jpeg ? { blob: jpeg, lossless: false } : null;
      })(),
      isTwilightTime(item.timeMs) ? this.sat.downloadUrl(url(SATELLITE_IR, half)) : Promise.resolve(null),
    ]);
    return hrv ? { blob: hrv.blob, lossless: hrv.lossless, twilightIr: twilightIr ?? undefined } : null;
  }

  /** The overlay picture of a window's frame, built once and shared. */
  private frameFor(win: SatelliteWindow, item: Item): Promise<SatelliteFrame | null> {
    let pending = this.built.get(item.rawKey);
    if (!pending) {
      const raw = this.raws.get(item.rawKey)!;
      pending = this.sat.process(raw.blob, item.product, raw.twilightIr, item.timeMs, win.bounds, raw.lossless).then(res => {
        if (!res) {
          this.built.delete(item.rawKey); // try again on the next refresh
          return null;
        }
        return { timeMs: item.timeMs, product: item.product, url: res.url };
      });
      this.built.set(item.rawKey, pending);
    }
    return pending;
  }

  /** Release the built pictures that are not for this window (null: all of them). */
  private prune(win: SatelliteWindow | null): void {
    const prefix = win ? `${win.id}|` : null;
    for (const [key, pending] of this.built) {
      if (prefix && key.startsWith(prefix)) continue;
      this.built.delete(key);
      void pending.then(f => f && URL.revokeObjectURL(f.url));
    }
  }
}
