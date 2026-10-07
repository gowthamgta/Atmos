import { Injectable, OnDestroy, computed, signal } from '@angular/core';
import { DEFAULT_MODEL_ID, ForecastModelDef, forecastModelById } from './forecast-models';
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
    this.manifest.set(null);
    this.inflight = null; // do not reuse a request that was for the previous model
    return this.refresh();
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

  private async load(): Promise<void> {
    if (!this.manifest()) this.status.set('loading');
    const { baseUrl, id } = this.model();
    try {
      const latest = await this.getJson<{ run: string; build?: string }>(`${baseUrl}/latest.json?t=${Math.floor(Date.now() / 60000)}`);
      if (id !== this.activeModelId()) return; // the model was switched while this request was in flight
      if (latest.run === this.manifest()?.run && (latest.build ?? '') === (this.manifest()?.build ?? '')) {
        this.status.set('ready');
        return;
      }
      const manifest = await this.getJson<ForecastManifest>(`${baseUrl}/${latest.run}/manifest.json${latest.build ? `?b=${encodeURIComponent(latest.build)}` : ''}`);
      if (id !== this.activeModelId()) return;
      this.manifest.set(manifest);
      this.status.set('ready');
    } catch (err) {
      console.warn('[forecast] catalog load failed', err);
      // Keep serving the manifest we already have; only flag an error if there is nothing to show.
      if (!this.manifest()) this.status.set('error');
    }
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return (await res.json()) as T;
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
