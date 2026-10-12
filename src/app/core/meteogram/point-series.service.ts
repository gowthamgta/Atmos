import { Injectable, signal } from '@angular/core';
import { FORECAST_MODELS } from '../forecast/forecast-models';
import { ApiModel, PointSeries, parsePointSeries, seriesUrl } from './point-series';

export type SeriesStatus = 'idle' | 'loading' | 'ready' | 'error';

const CACHE_MS = 15 * 60 * 1000;
const CACHE_SIZE = 8;
const TIMEOUT_MS = 12_000;
const RETRY_MS = 1_500;
/** Two places closer than this (about 1 km) share a download: the models' grids are 9 km at best. */
const KEY_DIGITS = 2;

const MODELS: readonly ApiModel[] = FORECAST_MODELS.map(m => ({ id: m.id, apiId: m.apiId }));

/**
 * The hourly forecast of every model at the place on the card, from Open-Meteo's forecast API, for the meteogram. One request of about 60 KB
 * (12 KB compressed) answers for all five models. Nothing is asked until the meteogram is open, and a place looked at in the last 15 minutes
 * is answered from memory.
 */
@Injectable({ providedIn: 'root' })
export class PointSeriesService {
  readonly data = signal<PointSeries | null>(null);
  readonly status = signal<SeriesStatus>('idle');
  readonly error = signal('');

  private readonly cache = new Map<string, { at: number; series: PointSeries }>();
  private token = 0;

  async load(lat: number, lon: number, force = false): Promise<void> {
    const key = `${lat.toFixed(KEY_DIGITS)},${lon.toFixed(KEY_DIGITS)}`;
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
    try {
      let attempt = 0;
      let series: PointSeries | null = null;
      for (;;) {
        attempt++;
        const res = await fetch(seriesUrl(lat, lon, MODELS), { signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined }).catch(() => null);
        if (res?.status === 429) throw new Error('The weather service is busy right now. Try again in a minute.');
        const json: unknown = res ? await res.json().catch(() => null) : null;
        series = res?.ok ? parsePointSeries(json, MODELS, lat, lon) : null;
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
      this.cache.set(key, { at: Date.now(), series });
      while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
      this.data.set(series);
      this.status.set('ready');
    } catch (err) {
      if (my !== this.token) return;
      this.error.set(err instanceof Error ? err.message : 'The forecast for this place could not be read.');
      this.status.set('error');
    }
  }
}
