import { Injectable, OnDestroy, computed, signal } from '@angular/core';
import { DEFAULT_MODEL_ID, FORECAST_MODELS, ForecastModelDef, forecastModelById } from './forecast-models';
import { ForecastManifest } from './forecast.model';

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Finds the newest published model run and keeps it fresh (Pages caches latest.json for ~10 min). */
@Injectable({ providedIn: 'root' })
export class ForecastCatalogService implements OnDestroy {
  private static readonly REFRESH_MS = 10 * 60 * 1000;

  /** Which model is shown; changing it reloads the catalog for that model. */
  readonly activeModelId = signal<string>(DEFAULT_MODEL_ID);
  readonly model = computed<ForecastModelDef>(() => forecastModelById(this.activeModelId()));
  readonly manifest = signal<ForecastManifest | null>(null);
  readonly status = signal<CatalogStatus>('idle');
  /** Valid times (epoch ms) of every step, ascending. */
  readonly validTimes = computed(() => this.manifest()?.steps.map(s => Date.parse(s.valid)) ?? []);
  readonly runLabel = computed(() => this.manifest()?.run ?? '');

  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  /**
   * Each model's newest run as last read (its manifest, with the synthesized levels, and when it was read): a model switched back to is
   * shown at once, and the others are read ahead in the background once the first is in, so switching does not wait for two downloads.
   */
  private readonly known = new Map<string, { manifest: ForecastManifest; synthesized: string[]; at: number }>();
  private aheadStarted = false;

  /** Loads once and starts the periodic refresh. Safe to call repeatedly. */
  ensureLoaded(): Promise<void> {
    if (!this.timer && typeof setInterval === 'function') {
      this.timer = setInterval(() => void this.refresh(), ForecastCatalogService.REFRESH_MS);
    }
    return this.manifest() ? Promise.resolve() : this.refresh();
  }

  /** Switch model: drops the current run and loads the newest run of the new model. */
  setModel(id: string): Promise<void> {
    if (id === this.activeModelId()) return Promise.resolve();
    this.activeModelId.set(id);
    this.inflight = null; // do not reuse a request that was for the previous model
    const known = this.known.get(id);
    if (known) {
      // shown at once; a newer run, if any, replaces it when latest.json says so
      this.useManifest(known.manifest, known.synthesized);
      if (Date.now() - known.at < ForecastCatalogService.REFRESH_MS) return Promise.resolve();
      void this.refresh();
      return Promise.resolve();
    }
    this.manifest.set(null);
    return this.refresh();
  }

  private useManifest(manifest: ForecastManifest, synthesized: readonly string[]): void {
    this.synthesizedVars.clear();
    for (const v of synthesized) this.synthesizedVars.add(v);
    this.manifest.set(manifest);
    this.status.set('ready');
  }

  /** Reads the other models' newest runs in the background (two small files each), one after another, once the first model is in. */
  private readAhead(): void {
    if (this.aheadStarted || typeof window === 'undefined') return;
    this.aheadStarted = true;
    const idle = (fn: () => void) => ('requestIdleCallback' in window ? window.requestIdleCallback(fn, { timeout: 5000 }) : setTimeout(fn, 2000));
    idle(async () => {
      for (const def of FORECAST_MODELS) {
        if (this.known.has(def.id)) continue;
        try {
          const latest = await this.getJson<{ run: string; build?: string }>(`${def.baseUrl}/latest.json?t=${Math.floor(Date.now() / 60000)}`, 'low');
          const manifest = await this.getJson<ForecastManifest>(`${def.baseUrl}/${latest.run}/manifest.json${latest.build ? `?b=${encodeURIComponent(latest.build)}` : ''}`, 'low');
          if (!this.known.has(def.id)) this.known.set(def.id, { manifest, synthesized: synthesizeLevels(manifest), at: Date.now() });
        } catch {
          // read when the model is chosen
        }
      }
    });
  }

  /** Re-reads latest.json and, if the run changed, the manifest. De-duplicates concurrent calls. */
  refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => (this.inflight = null));
    return this.inflight;
  }

  /** Address of one picture. The build (when the manifest has one) is part of it, so a run built again is fetched afresh. */
  fieldUrl(varId: string, stepHour: number, run = this.manifest()?.run, build = this.manifest()?.build): string {
    return `${this.model().baseUrl}/${run}/${varId}/${String(stepHour).padStart(3, '0')}.png${build ? `?b=${encodeURIComponent(build)}` : ''}`;
  }

  /** Variables synthesized in the browser by log-pressure interpolation when the published run only has 850, 700 and 500 hPa. */
  private readonly synthesizedVars = new Set<string>();

  isSynthesizedVar(varId: string): boolean {
    return this.synthesizedVars.has(varId);
  }

  private async load(): Promise<void> {
    if (!this.manifest()) this.status.set('loading');
    const { baseUrl, id } = this.model();
    try {
      const latest = await this.getJson<{ run: string; build?: string }>(`${baseUrl}/latest.json?t=${Math.floor(Date.now() / 60000)}`);
      if (id !== this.activeModelId()) return; // the model was switched while this request was in flight
      if (latest.run === this.manifest()?.run && (latest.build ?? '') === (this.manifest()?.build ?? '')) {
        const k = this.known.get(id);
        if (k) k.at = Date.now();
        this.status.set('ready');
        this.readAhead();
        return;
      }
      const manifest = await this.getJson<ForecastManifest>(`${baseUrl}/${latest.run}/manifest.json${latest.build ? `?b=${encodeURIComponent(latest.build)}` : ''}`);
      if (id !== this.activeModelId()) return;
      const synthesized = synthesizeLevels(manifest);
      this.known.set(id, { manifest, synthesized, at: Date.now() });
      this.useManifest(manifest, synthesized);
      this.readAhead();
    } catch (err) {
      console.warn('[forecast] catalog load failed', err);
      // Keep serving the manifest we already have; only flag an error if there is nothing to show.
      if (!this.manifest()) this.status.set('error');
    }
  }

  private async getJson<T>(url: string, priority: 'auto' | 'low' = 'auto'): Promise<T> {
    const res = await fetch(url, priority === 'low' ? { priority: 'low' } : undefined);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return (await res.json()) as T;
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/**
 * Adds the 800 and 600 hPa levels a run does not publish, worked out in the browser from the levels either side (see FieldLoaderService),
 * to its manifest; returns their names.
 */
function synthesizeLevels(manifest: ForecastManifest): string[] {
  const out: string[] = [];
  const brackets: readonly { level: 800 | 600; below: number; above: number; t: [number, number]; gh: [number, number] }[] = [
    { level: 800, below: 850, above: 700, t: [0, 28], gh: [1600, 2400] },
    { level: 600, below: 700, above: 500, t: [-18, 12], gh: [3900, 4700] },
  ];
  for (const b of brackets) {
    for (const kind of ['u', 'v', 't', 'rh', 'gh', 'w', 'vo', 'dv'] as const) {
      const varId = `${kind}${b.level}`;
      const belowInfo = manifest.vars[`${kind}${b.below}`];
      const aboveInfo = manifest.vars[`${kind}${b.above}`];
      if (!manifest.vars[varId] && belowInfo && aboveInfo) {
        const [min, max] = kind === 't' ? b.t : kind === 'gh' ? b.gh : [belowInfo.min, belowInfo.max];
        manifest.vars[varId] = { unit: belowInfo.unit, min, max, encoding: 'rg16' };
        out.push(varId);
      }
    }
  }
  return out;
}
