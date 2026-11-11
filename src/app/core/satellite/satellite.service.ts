import { Injectable, computed, signal } from '@angular/core';
import type { SatelliteWorkerRequest, SatelliteWorkerResponse, SatelliteFlowRequest, SatelliteDecodeRequest } from './satellite.worker';
import { CustomChannel, DEFAULT_CUSTOM, DataPack, OWN_SATELLITES, OwnIndex, OwnKind, OwnSatellite, autoKind, isDayKind, isShaderKind, readDataPack } from './own-products';
import { isPhone } from '../ui/device-profile';
import { readFlag, writeFlag } from '../ui/saved-flag';
import { GeoBounds, SATELLITE_BOUNDS, SATELLITE_HRV, SATELLITE_IR, SatelliteProduct, productForTime } from './satellite.config';
import { SatelliteHoverReading, classifyCloudTop, irTempToHeightKm } from './satellite-image';
import type { FlowField, MotionGrid } from './satellite-flow';

export interface SatelliteFrame {
  timeMs: number;
  product: SatelliteProduct;
  /** Object URL of the finished overlay picture. */
  url: string;
  /** How much cloud is where, for the loop's motion between pictures (satellite-flow.ts). */
  motion?: MotionGrid;
  /** One of our own pictures (own-products.ts): which, the ground it covers, and its data pack (brightness temperatures). */
  own: { kind: OwnKind; satellite: OwnSatellite; bounds: GeoBounds; dataUrl: string; dataBounds?: GeoBounds; minK: number; spanK: number };
}

/** Time a picture is shown while playing, and the pause on the newest picture before the loop restarts. */
const STEP_MS = 1100;
const HOLD_MS = 1800;
/** How often to ask the service whether a newer picture exists (a tiny request; a picture is fetched only when there is one). */
const CHECK_MS = 2 * 60_000;

/**
 * Our own satellite pictures (own-products.ts: made by the satellite workflow from Meteosat-9's or Himawari-9's raw data) as a loop of the
 * last 4 hours that moves the clouds from one picture to the next. The workflow's index is looked at every couple of minutes.
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
  /** The rest of the 4 hours is only downloaded once Play is pressed: first the newest picture, then the two before it (for the slider). */
  readonly historyRequested = signal(false);
  /** The satellite layer is on (the pictures are being kept fresh). */
  readonly active = signal(false);
  /** Show the infrared picture also by day (the switch in the panel); off: the visible HRV by day, infrared at night. */
  readonly infraredOnly = signal(readFlag('atmosiq.satellite.infrared', false));
  /** Which of our pictures is drawn. Unless the viewer picks one, it follows the day: infrared at night, our RGB by day. */
  readonly source = signal<OwnKind>(autoKind(readOwnSatellite(), isDayNow()));
  /** The kind the viewer picked (until the page is loaded again); null: follow the day. */
  private picked: OwnKind | null = null;
  /** The custom RGB's recipe (own-products.ts), remembered between visits. */
  readonly custom = signal<readonly CustomChannel[]>(readCustom());
  /** Whose raw data our own pictures come from: Meteosat-9 (the forecast box) or Himawari-9 (the east). */
  readonly ownSatellite = signal<OwnSatellite>(readOwnSatellite());
  /** Why our own source shows nothing: a daytime picture at night, or nothing published yet. */
  readonly ownEmpty = signal<'night' | 'none' | null>(null);

  /** The picture the loop is nearest to. */
  readonly current = computed<SatelliteFrame | null>(() => this.frames()[Math.round(this.position())] ?? null);
  /** When the pictures were last published by our satellite workflow (null: not known yet). */
  readonly updatedAtMs = signal<number | null>(null);
  /** Minutes since then. */
  readonly updatedAgoMinutes = computed(() => {
    const at = this.updatedAtMs();
    return at !== null && this.current() ? Math.max(0, Math.round((this.now() - at) / 60_000)) : null;
  });
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
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private raf = 0;
  private loadToken = 0;
  private playWhenReady = false;
  private lastHoverCoords: { lat: number; lon: number } | null = null;

  /** The viewer picks a kind of picture: it stays until the page is loaded again (otherwise the kind follows the day). */
  pickKind(kind: OwnKind): void {
    this.picked = kind;
    this.setSource(kind);
  }

  /** The kind that should be on now: the viewer's, or the day's. */
  private wantedKind(): OwnKind {
    const kinds = OWN_SATELLITES[this.ownSatellite()].kinds;
    if (this.picked && kinds.includes(this.picked)) return this.picked;
    return autoKind(this.ownSatellite(), isDayNow());
  }

  /** Show another of our pictures (the frames' times stay: only the picture changes). */
  setSource(source: OwnKind): void {
    if (this.source() === source) return;
    this.source.set(source);
    this.ownEmpty.set(null);
    if (this.active()) void this.load();
  }

  /** Our own pictures from the other satellite; a kind it does not make becomes its first. */
  setOwnSatellite(sat: OwnSatellite): void {
    if (this.ownSatellite() === sat) return;
    this.ownSatellite.set(sat);
    try {
      localStorage.setItem('atmosiq.satellite.ownSatellite', sat);
    } catch {
      // not remembered
    }
    this.pause();
    this.frames.set([]);
    const kind = this.wantedKind();
    if (kind !== this.source()) this.setSource(kind);
    else if (this.active()) void this.load();
  }

  setCustom(custom: readonly CustomChannel[]): void {
    this.custom.set(custom);
    try {
      localStorage.setItem('atmosiq.satellite.custom', JSON.stringify(custom));
    } catch {
      // not remembered
    }
  }

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
    if (this.clockTimer === null) this.clockTimer = setInterval(() => this.now.set(Date.now()), 30_000); // the "updated N min ago" counts on
    this.now.set(Date.now());
    if (!this.onVisible && typeof document !== 'undefined') {
      // back on the tab: look for the newest pictures at once (a hidden tab's timers are slowed, so the check may be minutes away)
      this.onVisible = () => {
        if (document.visibilityState === 'visible' && this.active()) void this.load();
      };
      document.addEventListener('visibilitychange', this.onVisible);
    }
    void this.load();
  }
  private onVisible: (() => void) | null = null;

  deactivate(): void {
    this.active.set(false);
    this.pause();
    this.clearHover();
    if (this.checkTimer !== null) clearInterval(this.checkTimer);
    this.checkTimer = null;
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    this.clockTimer = null;
    this.loadToken++; // abandon a load in progress
    this.loading.set(false);
    this.historyRequested.set(false);
    this.playWhenReady = false;
  }

  /** Sample Cloud-Top Temperature (°C) and Height (km) at `(lat, lon)` for the currently displayed frame. */
  inspectAt(lat: number, lon: number): void {
    this.lastHoverCoords = { lat, lon };
    const own = this.current()?.own;
    if (own) this.inspectOwn(own, lat, lon);
    else this.hoverReading.set(null);
  }

  clearHover(): void {
    this.lastHoverCoords = null;
    if (this.hoverReading() !== null) this.hoverReading.set(null);
  }

  /** The measured temperatures at a place from the frame's data pack (decoded in the worker the first time it is asked). */
  private inspectOwn(own: NonNullable<SatelliteFrame['own']>, lat: number, lon: number): void {
    const pack = this.pack?.url === own.dataUrl ? this.pack.pack : null;
    if (!pack) {
      this.hoverReading.set(null);
      if (this.packLoading !== own.dataUrl) {
        this.packLoading = own.dataUrl;
        void this.decodePack(own.dataUrl).then(p => {
          if (this.packLoading !== own.dataUrl) return;
          this.packLoading = null;
          if (p) this.pack = { url: own.dataUrl, pack: { ...p, bounds: own.dataBounds ?? own.bounds, minK: own.minK, spanK: own.spanK } };
          if (p && this.lastHoverCoords) this.inspectAt(this.lastHoverCoords.lat, this.lastHoverCoords.lon);
        });
      }
      return;
    }
    const k = readDataPack(pack, lat, lon);
    if (!k) {
      this.hoverReading.set(null);
      return;
    }
    const tempC = Math.round((k.ir - 273.15) * 10) / 10;
    const { label, color } = classifyCloudTop(tempC);
    this.hoverReading.set({ lat, lon, tempC, heightKm: irTempToHeightKm(tempC), label, color, measured: k });
  }

  private pack: { url: string; pack: DataPack } | null = null;
  private packLoading: string | null = null;

  private decodePack(url: string): Promise<{ w: number; h: number; rgb: Uint8Array } | null> {
    if (typeof Worker === 'undefined') return Promise.resolve(null);
    if (this.workers.length === 0) this.workers = Array.from({ length: SatelliteService.poolSize() }, () => this.createWorker());
    const worker = this.workers[this.turn++ % this.workers.length];
    const id = this.nextRequest++;
    return new Promise(resolve => {
      this.pending.set(id, r => resolve('pack' in r ? r.pack : null));
      worker.postMessage({ id, decode: url } satisfies SatelliteDecodeRequest);
    });
  }

  /** Our own frames of a kind, from the published index (the whole loop at once: they are small, finished pictures). */
  private async loadOwn(token: number, kind: OwnKind, satellite: OwnSatellite): Promise<void> {
    const base = OWN_SATELLITES[satellite].base;
    if (this.frames().length === 0) this.loading.set(true);
    this.failed.set(false);
    try {
      // a new query each time: GitHub Pages' cache keeps a file 10 minutes, so a run's new pictures show at the next check, not 10 minutes on
      const res = await fetch(`${base}index.json?t=${Date.now()}`, { cache: 'no-cache' });
      if (token !== this.loadToken) return;
      if (!res.ok) throw new Error(String(res.status));
      const index = (await res.json()) as OwnIndex;
      // when the satellite workflow last published (GitHub Pages gives its deploy time as the index's Last-Modified)
      const published = Date.parse(res.headers.get('last-modified') ?? '');
      if (Number.isFinite(published)) this.updatedAtMs.set(published);
      if (token !== this.loadToken || this.source() !== kind || this.ownSatellite() !== satellite) return;
      const following = this.position() >= this.frames().length - 1;
      // the RGB until its first frames are made: the colour picture the satellite has (natural or true colour), else the infrared
      let shown: OwnKind = kind;
      if (kind === 'rgb') {
        if (index.frames.some(f => f.files.rgb)) {
          await this.loadOwnRgb(token, index, satellite, base, following);
          return;
        }
        const colour: OwnKind = satellite === 'msg' ? 'natural' : 'truecolor';
        shown = index.frames.some(f => f.files[colour]) ? colour : 'infrared';
      }
      const picture = isShaderKind(shown) ? 'data' : shown;
      const list: SatelliteFrame[] = [];
      for (const f of loopFrames(index.frames, this.historyRequested())) {
        const file = f.files[picture];
        const data = f.files.data;
        const timeMs = Date.parse(f.time);
        if (!file || !data || !Number.isFinite(timeMs)) continue;
        list.push({
          timeMs,
          product: isDayKind(shown) ? SATELLITE_HRV : SATELLITE_IR,
          url: base + file,
          own: { kind: shown, satellite, bounds: index.bounds, dataUrl: base + data, minK: index.data.minK, spanK: index.data.spanK },
        });
      }
      this.setLoop(list, following);
      this.flows.set([]);
      this.ownEmpty.set(list.length === 0 ? (isDayKind(kind) && index.frames.length > 0 ? 'night' : 'none') : null);
    } catch {
      if (token === this.loadToken) this.failed.set(this.frames().length === 0);
    } finally {
      if (token === this.loadToken) this.loading.set(false);
    }
  }

  /** The RGB frames as built so far (by the picture's address), so a refresh only builds the new ones. */
  private readonly ownRgb = new Map<string, Promise<SatelliteFrame | null>>();

  /**
   * The RGB: each frame's HRV Cloud picture (pipeline: EUMETSAT's recipe from the raw data, uncompressed and at the satellite's own
   * resolution; the lighter one on a phone) is re-spaced to Mercator in the worker in its own colours, with the cloud cover the loop's
   * motion is worked out from. The newest first, then the rest of the loop.
   */
  private async loadOwnRgb(token: number, index: OwnIndex, satellite: OwnSatellite, base: string, following: boolean): Promise<void> {
    const newest = Date.parse(index.frames[index.frames.length - 1]?.time ?? '');
    const items = loopFrames(index.frames, this.historyRequested())
      .map(f => {
        const timeMs = Date.parse(f.time);
        // full detail for the newest hour on a larger screen; the lighter picture for older frames and on phones (GPU memory: 4 hours of
        // full frames would be over half a gigabyte)
        const full = !isPhone() && newest - timeMs <= FULL_DETAIL_MS;
        return { timeMs, file: (full ? f.files.rgb : f.files.rgb_lo) ?? f.files.rgb ?? f.files.rgb_lo, data: f.files.data };
      })
      .filter((f): f is { timeMs: number; file: string; data: string } => Number.isFinite(f.timeMs) && !!f.file && !!f.data);
    if (items.length === 0) {
      this.frames.set([]);
      this.ownEmpty.set(index.frames.length > 0 ? 'night' : 'none');
      return;
    }
    this.ownEmpty.set(null);
    const build = (it: (typeof items)[number]): Promise<SatelliteFrame | null> => {
      const url = base + it.file;
      let p = this.ownRgb.get(url);
      if (!p) {
        p = fetch(url)
          .then(r => (r.ok ? r.blob() : null))
          .then(blob => (blob ? this.process(blob) : null))
          .then(res => res && {
            timeMs: it.timeMs,
            product: SATELLITE_HRV,
            url: res.url,
            motion: res.motion,
            own: { kind: 'rgb', satellite, bounds: SATELLITE_BOUNDS, dataBounds: index.bounds, dataUrl: base + it.data, minK: index.data.minK, spanK: index.data.spanK },
          } satisfies SatelliteFrame)
          .catch(() => null);
        p.then(f => { if (!f) this.ownRgb.delete(url); });   // tried again on the next refresh
        this.ownRgb.set(url, p);
      }
      return p;
    };
    const publish = async (): Promise<void> => {
      const built = (await Promise.all(items.map(it => (this.ownRgb.has(base + it.file) ? build(it) : Promise.resolve(null))))).filter((f): f is SatelliteFrame => !!f);
      if (token !== this.loadToken || this.source() !== 'rgb' || this.ownSatellite() !== satellite) return;
      this.setLoop(built, following);
      void this.updateFlows(built);
    };
    // the newest at once, then the two before it, then (once Play is pressed) the rest of the 4 hours, newest first, each batch shown as it is built
    await build(items[items.length - 1]);
    await publish();
    for (let i = items.length - 2; i >= 0; i -= 3) {
      await Promise.all(items.slice(Math.max(0, i - 2), i + 1).map(build));
      if (token !== this.loadToken) return;
      await publish();
    }
    // pictures that have left the hour are released
    const keep = new Set(items.map(it => base + it.file));
    for (const [url, p] of this.ownRgb) {
      if (keep.has(url) || !url.startsWith(base)) continue;
      this.ownRgb.delete(url);
      void p.then(f => f && URL.revokeObjectURL(f.url));
    }
  }

  async load(): Promise<void> {
    const token = ++this.loadToken;
    // the kind follows the day (infrared at night, our RGB by day) unless the viewer picked one
    const kind = this.wantedKind();
    if (kind !== this.source()) {
      this.source.set(kind);
      this.frames.set([]);
    }
    return this.loadOwn(token, kind, this.ownSatellite());
  }

  /** Download the rest of the 4 hours (Play), newest first; the newest three pictures are already there. */
  requestHistory(): void {
    if (this.historyRequested()) return;
    this.historyRequested.set(true);
    if (this.active()) void this.load();
  }

  /**
   * Shows a new list of frames. Watching the newest: it stays on the newest. Otherwise it stays on the same picture: older pictures joining
   * at the front (loaded in the background while playing or after a drag) move its place along by as many.
   */
  private setLoop(list: SatelliteFrame[], following: boolean): void {
    const old = this.frames();
    const shift = old.length > 0 && list.length > 0 ? list.filter(f => f.timeMs < old[0].timeMs).length - old.filter(f => f.timeMs < list[0].timeMs).length : 0;
    // whether the newest is watched is read now: the viewer may have dragged back while a batch was being built
    const onNewest = old.length > 0 ? this.position() >= old.length - 1 : following;
    this.frames.set(list);
    const top = Math.max(0, list.length - 1);
    this.position.update(p => (onNewest ? top : Math.min(Math.max(p + shift, 0), top)));
    if (this.playWhenReady && list.length >= 2) {
      this.playWhenReady = false;
      this.play();
    }
  }

  /** One of our RGB pictures re-spaced to Mercator in its own colours (an object URL), with its cloud cover for the loop's motion, built in a worker. */
  private process(picture: Blob): Promise<{ url: string; motion?: MotionGrid } | null> {
    if (typeof Worker === 'undefined') return Promise.resolve(null);
    if (this.workers.length === 0) this.workers = Array.from({ length: SatelliteService.poolSize() }, () => this.createWorker());
    const worker = this.workers[this.turn++ % this.workers.length];
    const id = this.nextRequest++;
    return new Promise(resolve => {
      this.pending.set(id, r => resolve('png' in r ? { url: URL.createObjectURL(r.png), motion: r.motion } : null));
      worker.postMessage({ id, picture } satisfies SatelliteWorkerRequest);
    });
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
    if (this.playing()) return;
    // the older pictures load in the background, newest first, and join the loop as they come
    this.requestHistory();
    if (this.frames().length < 2) {
      this.playWhenReady = true; // started once there are two
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

/** Day over India now (the visible channels are usable). */
function isDayNow(): boolean {
  return productForTime(Date.now()).id === 'hrv';
}

function readCustom(): readonly CustomChannel[] {
  try {
    const v = JSON.parse(localStorage.getItem('atmosiq.satellite.custom') ?? 'null');
    if (Array.isArray(v) && v.length === 3 && v.every(c => [c.source, c.min, c.max, c.gamma].every(x => typeof x === 'number'))) return v;
  } catch {
    // the default
  }
  return DEFAULT_CUSTOM;
}

function readOwnSatellite(): OwnSatellite {
  try {
    return localStorage.getItem('atmosiq.satellite.ownSatellite') === 'h9' ? 'h9' : 'msg';
  } catch {
    return 'msg';
  }
}

/** Our own frames newer than this before the newest are drawn in full detail (larger screens); older ones in the lighter picture. */
const FULL_DETAIL_MS = 60 * 60_000;
/** How far back the loop of our own frames goes (the workflow keeps a little more). */
const LOOP_MS = 4 * 3_600_000;
/** Frames loaded before Play: the newest and the two before it (the slider can be dragged over them). */
const FIRST_FRAMES = 3;

/**
 * The frames of our own loop: the newest three until Play is pressed, then the last 4 hours. On a phone, past the
 * newest hour, one frame every 30 minutes (each frame is a picture in the phone's memory).
 */
function loopFrames<T extends { time: string }>(frames: readonly T[], history: boolean): T[] {
  if (frames.length === 0) return [];
  if (!history) return frames.slice(-FIRST_FRAMES);
  const newest = Date.parse(frames[frames.length - 1].time);
  let lastKept = Infinity;
  const out: T[] = [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const t = Date.parse(frames[i].time);
    if (newest - t > LOOP_MS) break;
    if (isPhone() && newest - t > FULL_DETAIL_MS && lastKept - t < 29 * 60_000) continue;
    out.unshift(frames[i]);
    lastKept = t;
  }
  return out;
}
