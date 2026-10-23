import { Injectable, inject, signal } from '@angular/core';
import { OWN_SATELLITES, OwnIndex } from './own-products';
import type { GeoBounds } from './satellite.config';
import { DeepPartial, RealRadarInput, StrikeInput, SYNTHETIC_RADAR_CONFIG, SyntheticRadarConfig, SyntheticRadarStats, WindGrids, tuneConfig } from './synthetic-radar';
import type { SyntheticRadarRequest, SyntheticRadarResponse } from './synthetic-radar.worker';
import { ForecastCatalogService } from '../forecast/forecast-catalog.service';
import { FieldLoaderService } from '../forecast/field-loader.service';
import { decodeFieldBitmap } from '../forecast/field-decode';
import { bracketSteps } from '../forecast/forecast.model';
import { isPhone } from '../ui/device-profile';

/** How often the newest frame is looked for while the radar is on (the satellite workflow publishes every 15 minutes). */
const REFRESH_MS = 5 * 60_000;
/** How often the synthetic radar is built again for new lightning (a phone less often: it is a few hundred ms of a worker's time). */
const LIGHTNING_MS = isPhone() ? 120_000 : 60_000;

export interface SatelliteRainData {
  /** Reflectivity x 4 per pixel over bounds (synthetic-radar.ts), 0 where there is none. */
  dbz4: Uint8Array;
  w: number;
  h: number;
  bounds: GeoBounds;
  /** The satellite frame's time. */
  timeMs: number;
  stats: SyntheticRadarStats;
}

/** What the map gives the estimate: the lightning, and the real radar (its picture and the discs of the radars that work). */
export interface SatelliteRainInputs {
  strikes: () => readonly StrikeInput[];
  radar: () => RealRadarInput | null;
}

/** The synthetic radar drawn where no working radar sees (synthetic-radar.ts, drawn by rendering/satellite-rain.layer.ts). */
@Injectable({ providedIn: 'root' })
export class SatelliteRainService {
  private readonly catalog = inject(ForecastCatalogService);
  private readonly loader = inject(FieldLoaderService);
  readonly latest = signal<SatelliteRainData | null>(null);
  readonly config = signal<SyntheticRadarConfig>(SYNTHETIC_RADAR_CONFIG);
  private inputs: SatelliteRainInputs | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private lightningTimer: ReturnType<typeof setInterval> | null = null;
  private frame: { url: string; prevUrl?: string; prevMinutes?: number; bounds: GeoBounds; minK: number; spanK: number; timeMs: number } | null = null;
  private worker: Worker | null = null;
  private nextId = 0;
  private busy = false;
  private again = false;

  constructor() {
    // live tuning from the browser console: atmosSyntheticRadar.set({ anvil: { ringDiffMinK: 4 } })
    (globalThis as Record<string, unknown>)['atmosSyntheticRadar'] = {
      config: () => this.config(),
      stats: () => this.latest()?.stats ?? null,
      set: (patch: DeepPartial<SyntheticRadarConfig>) => {
        this.config.set(tuneConfig(this.config(), patch));
        void this.build();
        return this.config();
      },
      reset: () => {
        this.config.set(SYNTHETIC_RADAR_CONFIG);
        void this.build();
      },
    };
  }

  setInputs(inputs: SatelliteRainInputs): void {
    this.inputs = inputs;
  }

  activate(): void {
    if (this.frameTimer !== null) return;
    void this.refresh();
    this.frameTimer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.lightningTimer = setInterval(() => void this.build(), LIGHTNING_MS);
  }

  deactivate(): void {
    if (this.frameTimer !== null) clearInterval(this.frameTimer);
    if (this.lightningTimer !== null) clearInterval(this.lightningTimer);
    this.frameTimer = this.lightningTimer = null;
  }

  /** Builds it again now (the real radar changed, say). */
  rebuild(): void {
    if (this.frameTimer !== null) void this.build();
  }

  private async refresh(): Promise<void> {
    try {
      const base = OWN_SATELLITES.msg.base;
      const res = await fetch(base + 'index.json', { cache: 'no-cache' });
      if (!res.ok) return;
      const index = (await res.json()) as OwnIndex;
      const withData = index.frames.filter(fr => fr.files.data);
      const f = withData[withData.length - 1];
      if (!f) return;
      const url = base + f.files.data!;
      if (this.frame?.url === url) return;
      const timeMs = Date.parse(f.time);
      // the frame before it, 10 to 20 minutes older, for the new popups
      const before = [...withData].reverse().find(fr => {
        const dt = timeMs - Date.parse(fr.time);
        return dt >= 10 * 60_000 && dt <= 20 * 60_000;
      });
      this.frame = {
        url,
        prevUrl: before ? base + before.files.data! : undefined,
        prevMinutes: before ? (timeMs - Date.parse(before.time)) / 60_000 : undefined,
        bounds: index.bounds,
        minK: index.data.minK,
        spanK: index.data.spanK,
        timeMs,
      };
      await this.build();
    } catch {
      // the next refresh tries again
    }
  }

  private async build(): Promise<void> {
    const frame = this.frame;
    if (!frame || typeof Worker === 'undefined') return;
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      const wind = await this.winds(frame.timeMs);
      const req: SyntheticRadarRequest = {
        id: ++this.nextId,
        url: frame.url,
        prevUrl: frame.prevUrl,
        prevMinutes: frame.prevMinutes,
        box: frame.bounds,
        minK: frame.minK,
        spanK: frame.spanK,
        wind,
        strikes: (this.inputs?.strikes() ?? []).map(s => ({ lat: s.lat, lon: s.lon, ageS: s.ageS })),
        radar: this.inputs?.radar() ?? null,
        config: this.config(),
      };
      const reply = await this.run(req);
      if ('dbz4' in reply && this.frame === frame) {
        this.latest.set({ dbz4: reply.dbz4, w: reply.w, h: reply.h, bounds: frame.bounds, timeMs: frame.timeMs, stats: reply.stats });
      }
    } catch {
      // kept as it was; the next build tries again
    } finally {
      this.busy = false;
      if (this.again) {
        this.again = false;
        void this.build();
      }
    }
  }

  private run(req: SyntheticRadarRequest): Promise<SyntheticRadarResponse> {
    if (!this.worker) this.worker = new Worker(new URL('./synthetic-radar.worker', import.meta.url), { type: 'module' });
    const worker = this.worker;
    return new Promise(resolve => {
      const done = (e: MessageEvent<SyntheticRadarResponse>) => {
        if (e.data.id !== req.id) return;
        worker.removeEventListener('message', done);
        resolve(e.data);
      };
      worker.addEventListener('message', done);
      worker.postMessage(req);
    });
  }

  /** The forecast 850 and 250 hPa winds at the frame's time (the nearer step), or null without them. */
  private async winds(timeMs: number): Promise<WindGrids | null> {
    try {
      await this.catalog.ensureLoaded();
      const m = this.catalog.manifest();
      if (!m) return null;
      const ids = ['u850', 'v850', 'u250', 'v250'];
      if (!ids.every(id => id in m.vars)) return null;
      const { a, b, mix } = bracketSteps(this.catalog.validTimes(), timeMs);
      const step = m.steps[mix < 0.5 ? a : b].h;
      const [u850, v850, u250, v250] = await Promise.all(ids.map(async id => decodeFieldBitmap(await this.loader.get(id, step, 'low'), m.vars[id].min, m.vars[id].max)));
      return { grid: m.grid, u850, v850, u250, v250 };
    } catch {
      return null;
    }
  }
}
