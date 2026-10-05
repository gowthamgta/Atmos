import { Injectable, OnDestroy, computed, signal } from '@angular/core';
import { FORECAST_BASE_URL, ForecastManifest } from './forecast.model';

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Finds the newest published model run and keeps it fresh (Pages caches latest.json for ~10 min). */
@Injectable({ providedIn: 'root' })
export class ForecastCatalogService implements OnDestroy {
  private static readonly REFRESH_MS = 10 * 60 * 1000;

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

  /** Re-reads latest.json and, if the run changed, the manifest. De-duplicates concurrent calls. */
  refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => (this.inflight = null));
    return this.inflight;
  }

  fieldUrl(varId: string, stepHour: number, run = this.manifest()?.run): string {
    return `${FORECAST_BASE_URL}/${run}/${varId}/${String(stepHour).padStart(3, '0')}.png`;
  }

  private async load(): Promise<void> {
    if (!this.manifest()) this.status.set('loading');
    try {
      const latest = await this.getJson<{ run: string }>(`${FORECAST_BASE_URL}/latest.json?t=${Math.floor(Date.now() / 60000)}`);
      if (latest.run === this.manifest()?.run) {
        this.status.set('ready');
        return;
      }
      const manifest = await this.getJson<ForecastManifest>(`${FORECAST_BASE_URL}/${latest.run}/manifest.json`);
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
