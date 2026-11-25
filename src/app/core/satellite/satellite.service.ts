import { Injectable, computed, signal } from '@angular/core';
import type { SatelliteWorkerResponse, SatelliteDecodeRequest } from './satellite.worker';
import { CustomChannel, DEFAULT_CUSTOM, DataPack, OwnKind, OwnSatellite, readDataPack } from './own-products';
import { GeoBounds, SATELLITE_HRV, SATELLITE_IR, SatelliteProduct } from './satellite.config';
import { SatelliteHoverReading, classifyCloudTop, irTempToHeightKm } from './satellite-image';
import type { FlowField } from './satellite-flow';

export interface SatelliteFrame {
  timeMs: number;
  product: SatelliteProduct;
  url: string;
  own: { kind: OwnKind; satellite: OwnSatellite; bounds: GeoBounds; dataUrl: string; dataBounds?: GeoBounds; minK: number; spanK: number };
}

interface GlobalIndex {
  bounds: GeoBounds;
  offsetK?: number;
  stepK?: number;
  data?: { minK: number; spanK: number };
  frames?: { time: string; file?: string; files?: { data?: string } }[];
}

const SATELLITE_SITE = 'https://gowthamgta.github.io/atmos-satellite/';
const STEP_MS = 1100;
const HOLD_MS = 1800;
const CHECK_MS = 2 * 60_000;

/**
 * Unified Global Satellite feed (`rgb-global/` and `bt-global/`) combining GOES-West, GOES-East,
 * Meteosat-0, Meteosat-9, and Himawari-9 stitched by best viewing angle on a Web Mercator grid,
 * with high-resolution regional IR (`bt/`) stacked seamlessly over India.
 */
@Injectable({ providedIn: 'root' })
export class SatelliteService {
  readonly frames = signal<SatelliteFrame[]>([]);
  readonly flows = signal<(FlowField | null)[]>([]);
  readonly position = signal(0);
  readonly playing = signal(false);
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly opacity = signal(1);
  readonly hoverReading = signal<SatelliteHoverReading | null>(null);
  readonly historyRequested = signal(false);
  readonly active = signal(false);
  readonly source = signal<'rgb' | 'infrared'>(readMode());
  readonly custom = signal<readonly CustomChannel[]>(readCustom());
  /** Optional high-res regional 3km India IR overlay stacked cleanly over global IR. */
  readonly regionalIr = signal<{ bounds: GeoBounds; minK: number; spanK: number; url: string } | null>(null);
  /** Global IR metadata kept for compatibility with global hover inspection. */
  readonly globalIr = signal<{ bounds: GeoBounds; minK: number; spanK: number; url: string } | null>(null);
  /** Always null in GeoColor global RGB mode (24/7 day+night). */
  readonly ownEmpty = signal<'night' | 'none' | null>(null);

  readonly current = computed<SatelliteFrame | null>(() => this.frames()[Math.round(this.position())] ?? null);
  readonly updatedAtMs = signal<number | null>(null);
  readonly updatedAgoMinutes = computed(() => {
    const at = this.updatedAtMs();
    return at !== null && this.current() ? Math.max(0, Math.round((this.now() - at) / 60_000)) : null;
  });
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
  private onVisible: (() => void) | null = null;
  private pack: { url: string; pack: DataPack } | null = null;
  private packLoading: string | null = null;

  pickKind(kind: OwnKind): void {
    const mode: 'rgb' | 'infrared' = kind === 'infrared' ? 'infrared' : 'rgb';
    if (this.source() === mode) return;
    this.source.set(mode);
    try {
      localStorage.setItem('atmosiq.satellite.mode', mode);
    } catch {}
    this.frames.set([]);
    if (this.active()) void this.load();
  }

  setSource(source: OwnKind): void {
    this.pickKind(source);
  }

  setCustom(custom: readonly CustomChannel[]): void {
    this.custom.set(custom);
    try {
      localStorage.setItem('atmosiq.satellite.custom', JSON.stringify(custom));
    } catch {}
  }

  activate(): void {
    this.active.set(true);
    if (this.checkTimer === null) this.checkTimer = setInterval(() => void this.load(), CHECK_MS);
    if (this.clockTimer === null) this.clockTimer = setInterval(() => this.now.set(Date.now()), 30_000);
    this.now.set(Date.now());
    if (!this.onVisible && typeof document !== 'undefined') {
      this.onVisible = () => {
        if (document.visibilityState === 'visible' && this.active()) void this.load();
      };
      document.addEventListener('visibilitychange', this.onVisible);
    }
    void this.load();
  }

  deactivate(): void {
    this.active.set(false);
    this.pause();
    this.clearHover();
    if (this.checkTimer !== null) clearInterval(this.checkTimer);
    this.checkTimer = null;
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    this.clockTimer = null;
    this.loadToken++;
    this.loading.set(false);
    this.historyRequested.set(false);
    this.playWhenReady = false;
  }

  inspectAt(lat: number, lon: number): void {
    this.lastHoverCoords = { lat, lon };
    const own = this.current()?.own;
    if (!own?.dataUrl) {
      this.hoverReading.set(null);
      return;
    }
    const pack = this.pack?.url === own.dataUrl ? this.pack.pack : null;
    if (!pack) {
      this.hoverReading.set(null);
      if (this.packLoading !== own.dataUrl) {
        this.packLoading = own.dataUrl;
        void this.decodePack(own.dataUrl).then(p => {
          if (this.packLoading !== own.dataUrl) return;
          this.packLoading = null;
          if (p) {
            this.pack = {
              url: own.dataUrl,
              pack: { ...p, bounds: own.dataBounds ?? own.bounds, minK: own.minK, spanK: own.spanK },
            };
          }
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

  clearHover(): void {
    this.lastHoverCoords = null;
    if (this.hoverReading() !== null) this.hoverReading.set(null);
  }

  private decodePack(url: string): Promise<{ w: number; h: number; rgb: Uint8Array } | null> {
    if (typeof Worker === 'undefined') return Promise.resolve(null);
    if (this.workers.length === 0) this.workers = [this.createWorker()];
    const worker = this.workers[this.turn++ % this.workers.length];
    const id = this.nextRequest++;
    return new Promise(resolve => {
      this.pending.set(id, r => resolve('pack' in r ? r.pack : null));
      worker.postMessage({ id, decode: url } satisfies SatelliteDecodeRequest);
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

  async load(): Promise<void> {
    const token = ++this.loadToken;
    const mode = this.source();
    if (this.frames().length === 0) this.loading.set(true);
    this.failed.set(false);
    this.ownEmpty.set(null);

    try {
      const cacheBust = `?t=${Date.now()}`;
      const [btRes, rgbRes, regRes] = await Promise.all([
        fetch(`${SATELLITE_SITE}bt-global/index.json${cacheBust}`, { cache: 'no-cache' }),
        mode === 'rgb' ? fetch(`${SATELLITE_SITE}rgb-global/index.json${cacheBust}`, { cache: 'no-cache' }) : Promise.resolve(null),
        mode === 'infrared' ? fetch(`${SATELLITE_SITE}rgb-msg/index.json${cacheBust}`, { cache: 'no-cache' }).catch(() => null) : Promise.resolve(null),
      ]);
      if (token !== this.loadToken || this.source() !== mode) return;

      const btIdx = btRes.ok ? ((await btRes.json()) as GlobalIndex) : null;
      const btBase = `${SATELLITE_SITE}bt-global/`;
      const btFrames = btIdx?.frames ?? [];
      const btMinK = btIdx?.offsetK ?? 180;
      const btSpanK = (btIdx?.stepK ?? 0.5) * 255;
      const latestBt = btFrames[btFrames.length - 1];
      if (btIdx && latestBt?.file) {
        this.globalIr.set({ bounds: btIdx.bounds, minK: btMinK, spanK: btSpanK, url: btBase + latestBt.file });
      }

      if (regRes?.ok) {
        const regIdx = (await regRes.json()) as GlobalIndex;
        const regLast = regIdx.frames?.[regIdx.frames.length - 1];
        const dataFile = regLast?.files?.data;
        if (dataFile && regIdx.data) {
          this.regionalIr.set({
            bounds: regIdx.bounds,
            minK: regIdx.data.minK,
            spanK: regIdx.data.spanK,
            url: `${SATELLITE_SITE}rgb-msg/${dataFile}`,
          });
        }
      }

      const following = this.position() >= Math.max(this.frames().length - 1, 0);

      if (mode === 'rgb' && rgbRes?.ok) {
        const rgbIdx = (await rgbRes.json()) as GlobalIndex;
        const published = Date.parse(rgbRes.headers.get('last-modified') ?? '');
        if (Number.isFinite(published)) this.updatedAtMs.set(published);
        const rgbBase = `${SATELLITE_SITE}rgb-global/`;
        const list: SatelliteFrame[] = [];
        for (const f of rgbIdx.frames ?? []) {
          const timeMs = Date.parse(f.time);
          if (!f.file || !Number.isFinite(timeMs)) continue;
          const matchingBt = btFrames.find(b => b.time === f.time)?.file ?? latestBt?.file ?? '';
          list.push({
            timeMs,
            product: SATELLITE_HRV,
            url: rgbBase + f.file,
            own: {
              kind: 'rgb',
              satellite: 'h9',
              bounds: rgbIdx.bounds,
              dataUrl: matchingBt ? btBase + matchingBt : '',
              dataBounds: btIdx?.bounds,
              minK: btMinK,
              spanK: btSpanK,
            },
          });
        }
        if (list.length > 0) {
          this.setLoop(list, following);
          return;
        }
      }

      // Infrared mode (or fallback if rgb-global is unavailable)
      if (!btIdx || btFrames.length === 0) {
        throw new Error('No global satellite frames available');
      }
      const published = Date.parse(btRes.headers.get('last-modified') ?? '');
      if (Number.isFinite(published)) this.updatedAtMs.set(published);
      const list: SatelliteFrame[] = [];
      for (const f of btFrames) {
        const timeMs = Date.parse(f.time);
        if (!f.file || !Number.isFinite(timeMs)) continue;
        list.push({
          timeMs,
          product: SATELLITE_IR,
          url: btBase + f.file,
          own: {
            kind: 'infrared',
            satellite: 'h9',
            bounds: btIdx.bounds,
            dataUrl: btBase + f.file,
            dataBounds: btIdx.bounds,
            minK: btMinK,
            spanK: btSpanK,
          },
        });
      }
      this.setLoop(list, following);
    } catch {
      if (token === this.loadToken) this.failed.set(this.frames().length === 0);
    } finally {
      if (token === this.loadToken) this.loading.set(false);
    }
  }

  requestHistory(): void {
    this.historyRequested.set(true);
  }

  private setLoop(list: SatelliteFrame[], following: boolean): void {
    const old = this.frames();
    const onNewest = old.length > 0 ? this.position() >= old.length - 1 : following;
    this.frames.set(list);
    const top = Math.max(0, list.length - 1);
    this.position.update(p => (onNewest ? top : Math.min(Math.max(p, 0), top)));
    if (this.playWhenReady && list.length >= 2) {
      this.playWhenReady = false;
      this.play();
    }
  }

  setFrame(i: number): void {
    const n = this.frames().length;
    if (n > 0) this.position.set(Math.min(Math.max(Math.round(i), 0), n - 1));
  }

  step(delta: number): void {
    this.pause();
    const n = this.frames().length;
    if (n === 0) return;
    this.setFrame(Math.round(this.position()) + delta);
  }

  togglePlay(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  play(): void {
    if (this.playing()) return;
    this.requestHistory();
    if (this.frames().length < 2) {
      this.playWhenReady = true;
      return;
    }
    if (typeof requestAnimationFrame !== 'function') return;
    this.playing.set(true);
    if (this.position() >= this.frames().length - 1) this.position.set(0);
    let last = performance.now();
    let hold = 0;
    const tick = (now: number) => {
      if (!this.playing()) return;
      const dt = Math.min(now - last, 100);
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

function readMode(): 'rgb' | 'infrared' {
  try {
    return localStorage.getItem('atmosiq.satellite.mode') === 'infrared' ? 'infrared' : 'rgb';
  } catch {
    return 'rgb';
  }
}

function readCustom(): readonly CustomChannel[] {
  try {
    const v = JSON.parse(localStorage.getItem('atmosiq.satellite.custom') ?? 'null');
    if (Array.isArray(v) && v.length === 3 && v.every(c => [c.source, c.min, c.max, c.gamma].every(x => typeof x === 'number'))) return v;
  } catch {}
  return DEFAULT_CUSTOM;
}
