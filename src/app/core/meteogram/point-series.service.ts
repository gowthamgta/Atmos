import { Injectable, inject, signal } from '@angular/core';
import { FORECAST_MODELS, POINT_ONLY_MODELS } from '../forecast/forecast-models';
import { VerificationService } from '../forecast/verification.service';
import { BLEND_ID, CorrectionsFile, applyCorrections, blendSeries, extraBlendModels } from './blend';
import { ApiModel, PointSeries, parsePointSeries, seriesUrl } from './point-series';

export type SeriesStatus = 'idle' | 'loading' | 'ready' | 'error';

const CACHE_MS = 15 * 60 * 1000;
const CACHE_SIZE = 8;
const TIMEOUT_MS = 12_000;
const RETRY_MS = 1_500;
/** Two places closer than this (about 1 km) share a download: the models' grids are 9 km at best. */
const KEY_DIGITS = 2;

const MODELS: readonly ApiModel[] = [...FORECAST_MODELS, ...POINT_ONLY_MODELS].map(m => ({ id: m.id, apiId: m.apiId }));
/** How long the forecast waits for the corrections file before going without them (it is small and usually cached). */
const CORRECTIONS_WAIT_MS = 2500;

/**
 * The series as the meteogram shows it: each model corrected at the place, and the AtmosIQ Blend of them added (see blend.ts). The models only
 * the Blend needs stay in the series but are not drawn.
 */
export function withBlend(series: PointSeries, corr: CorrectionsFile | null): PointSeries {
  if (!corr) return series;
  const corrected = applyCorrections(series, corr);
  const b = blendSeries(corrected, corr);
  return b ? { ...corrected, models: { ...corrected.models, [BLEND_ID]: b.blend }, rainChance: b.rainChance } : corrected;
}

/**
 * The hourly forecast of every model at the place on the card, from Open-Meteo's forecast API, for the meteogram. One request of about 60 KB
 * (12 KB compressed) answers for all five models. Nothing is asked until the meteogram is open, and a place looked at in the last 15 minutes
 * is answered from memory.
 */
@Injectable({ providedIn: 'root' })
export class PointSeriesService {
  private readonly verification = inject(VerificationService);
  readonly data = signal<PointSeries | null>(null);
  readonly status = signal<SeriesStatus>('idle');
  readonly error = signal('');
  /** The place (to two decimals, "11.74,78.96") the last request failed for; empty when the last one worked. */
  readonly failedFor = signal('');

  private readonly cache = new Map<string, { at: number; series: PointSeries }>();
  private token = 0;
  private inflight: { key: string; promise: Promise<void> } | null = null;

  /**
   * Gets the forecast of a place (from memory when it was fetched in the last 15 minutes). Two askers for the same place at once, the place
   * card's days and the meteogram, share one request.
   */
  load(lat: number, lon: number, force = false): Promise<void> {
    const key = `${lat.toFixed(KEY_DIGITS)},${lon.toFixed(KEY_DIGITS)}`;
    if (this.inflight?.key === key && !force) return this.inflight.promise;
    const promise: Promise<void> = this.run(lat, lon, key, force).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null;
    });
    this.inflight = { key, promise };
    return promise;
  }

  private async run(lat: number, lon: number, key: string, force: boolean): Promise<void> {
    const hit = this.cache.get(key);
    if (hit && !force && Date.now() - hit.at < CACHE_MS) {
      ++this.token;
      this.data.set(hit.series);
      this.status.set('ready');
      this.error.set('');
      return;
    }
    const my = ++this.token;
    const current = this.data();
    if (!current || `${current.lat.toFixed(KEY_DIGITS)},${current.lon.toFixed(KEY_DIGITS)}` !== key) this.data.set(null); // never show another place's chart while this one loads
    this.status.set('loading');
    this.error.set('');
    this.failedFor.set('');
    try {
      const corr = await Promise.race([
        this.verification.loadCorrections(),
        new Promise<null>(resolve => setTimeout(() => resolve(null), CORRECTIONS_WAIT_MS)),
      ]);
      if (my !== this.token) return;
      const models: ApiModel[] = [...MODELS, ...extraBlendModels(corr, MODELS.map(m => m.id))];
      let attempt = 0;
      let series: PointSeries | null = null;
      for (;;) {
        attempt++;
        const res = await fetch(seriesUrl(lat, lon, models), { signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined }).catch(() => null);
        if (res?.status === 429) throw new Error('The weather service is busy right now. Try again in a minute.');
        const json: unknown = res ? await res.json().catch(() => null) : null;
        series = res?.ok ? parsePointSeries(json, models, lat, lon) : null;
        if (series) break;
        // a hiccup of the service (a server error, or no answer at all) is tried once more after a moment; a refusal (a bad request) is not
        const retryable = !res || res.status >= 500;
        if (retryable && attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, RETRY_MS));
          if (my !== this.token) return;
          continue;
        }
        if (!res) throw new Error('The weather service could not be reached. Check the connection and try again.');
        const reason = (json as { reason?: unknown } | null)?.reason;
        throw new Error(typeof reason === 'string' ? reason : 'The forecast for this place could not be read.');
      }
      if (my !== this.token) return; // a newer request replaced this one
      series = withBlend(series, corr);
      this.cache.set(key, { at: Date.now(), series });
      while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
      this.data.set(series);
      this.status.set('ready');
    } catch (err) {
      if (my !== this.token) return;
      this.error.set(err instanceof Error ? err.message : 'The forecast for this place could not be read.');
      this.failedFor.set(key);
      this.status.set('error');
    }
  }
}
