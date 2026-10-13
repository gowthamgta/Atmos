import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { isPhone } from '../ui/device-profile';
import {
  SATELLITE_BOUNDS,
  SATELLITE_IR,
  SATELLITE_NATURAL_LAYER,
  SATELLITE_SIZE,
  SatelliteProduct,
  isTwilightTime,
  satelliteFrameUrl,
} from './satellite.config';
import { SatelliteFrame, SatelliteService } from './satellite.service';
import { MapView, SatelliteWindow, WindowLimits, chooseWindow, kmPerPixel } from './satellite-window';

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
  natural?: Blob;
  twilightIr?: Blob;
}

interface Item {
  timeMs: number;
  product: SatelliteProduct;
  rawKey: string;
}

const DOWNLOAD_CONCURRENCY = 3;
/** Windows whose downloads are kept, so going back to a place does not fetch it again. */
const KEEP_WINDOWS = 3;
/** The wait after the map or the loop changes before the window is looked at again (a pinch or a fling makes many changes). */
const SETTLE_MS = 250;

/**
 * The closer pictures of the satellite loop. When the map is zoomed in, the whole-India picture's pixels (1.5 to 3 km) are coarser
 * than the high-resolution visible channel's detail (about 0.8 km), so a window of the same pictures at that finer pixel is fetched
 * for the part of the map in view (see satellite-window.ts for how it is chosen) and the map draws it over the main picture.
 *
 * It follows the main loop: one picture per frame, the same times, the same view (full, clouds, thermal) and enhancement, built in
 * the same worker. Only the HRV by day has anything finer to give; infrared and water vapour pictures are 4 to 6 km a pixel, no
 * finer than the main picture, so by night, or in those channels, there is no window.
 */
@Injectable({ providedIn: 'root' })
export class SatelliteDetailService {
  private readonly sat = inject(SatelliteService);

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
      // whatever changes which closer pictures are wanted: the main loop, what it shows, whether it is on
      this.sat.frames();
      this.sat.view();
      this.sat.enhance();
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
    const limits: WindowLimits = { maxPx: isPhone() ? 1024 : 1600, globalKmPerPx: kmPerPixel(SATELLITE_BOUNDS, SATELLITE_SIZE.width) };
    const win = chooseWindow(view, limits, this.wanted);
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

  /** The look the pictures are built for: the view, and for the full picture whether it is enhanced (as in SatelliteService). */
  private look(): { view: ReturnType<SatelliteService['view']>; enhance: boolean; key: string } {
    const view = this.sat.view();
    const enhance = view === 'picture' && this.sat.enhance();
    return { view, enhance, key: `${view}${enhance ? '+' : ''}` };
  }

  private async download(win: SatelliteWindow, item: Item): Promise<WindowRaw | null> {
    const half = { width: Math.max(64, Math.round(win.size.width / 2)), height: Math.max(64, Math.round(win.size.height / 2)) };
    const url = (product: SatelliteProduct, layer: string, size: { width: number; height: number }) =>
      satelliteFrameUrl(product, item.timeMs, layer, size, win.bounds);
    // the colour picture's pixels are 4-6 km: half the pixels of the HRV's hold all it has
    const [blob, natural, twilightIr] = await Promise.all([
      this.sat.downloadUrl(url(item.product, item.product.layer, win.size)),
      this.sat.downloadUrl(url(item.product, SATELLITE_NATURAL_LAYER, half)),
      isTwilightTime(item.timeMs) ? this.sat.downloadUrl(url(SATELLITE_IR, SATELLITE_IR.layer, half)) : Promise.resolve(null),
    ]);
    return blob ? { blob, natural: natural ?? undefined, twilightIr: twilightIr ?? undefined } : null;
  }

  /** The overlay picture of a window's frame in the current look, built once and shared. */
  private frameFor(win: SatelliteWindow, item: Item): Promise<SatelliteFrame | null> {
    const { view, enhance, key: lookKey } = this.look();
    const key = `${lookKey}|${item.rawKey}`;
    let pending = this.built.get(key);
    if (!pending) {
      const raw = this.raws.get(item.rawKey)!;
      pending = this.sat
        .process(raw.blob, item.product, view, view === 'clouds' || enhance ? raw.natural : undefined, raw.twilightIr, item.timeMs, enhance, win.bounds)
        .then(res => {
          if (!res) {
            this.built.delete(key); // try again on the next refresh
            return null;
          }
          return { timeMs: item.timeMs, product: item.product, url: res.url };
        });
      this.built.set(key, pending);
    }
    return pending;
  }

  /** Release the built pictures that are not for this window (null: all of them) in this look. */
  private prune(win: SatelliteWindow | null): void {
    const prefix = win ? `${this.look().key}|${win.id}|` : null;
    for (const [key, pending] of this.built) {
      if (prefix && key.startsWith(prefix)) continue;
      this.built.delete(key);
      void pending.then(f => f && URL.revokeObjectURL(f.url));
    }
  }
}
