import { Injectable, inject } from '@angular/core';
import { blendFields, encodeFieldBitmap } from './derived-fields';
import { decodeFieldBitmap, isEmptyField } from './field-decode';
import { ForecastCatalogService } from './forecast-catalog.service';
import { ForecastManifest } from './forecast.model';

/** The two levels a variable at 800 or 600 hPa is worked out from, and how far between them it lies (linear in ln p); null for any other variable. */
function levelNeighbours(varId: string): { belowId: string; aboveId: string; mix: number } | null {
  const m = /^([a-z]+)(800|600)$/.exec(varId);
  if (!m) return null;
  const is800 = m[2] === '800';
  return {
    belowId: `${m[1]}${is800 ? 850 : 700}`,
    aboveId: `${m[1]}${is800 ? 700 : 500}`,
    mix: is800 ? Math.log(850 / 800) / Math.log(850 / 700) : Math.log(700 / 600) / Math.log(700 / 500),
  };
}

/** The longest one picture may take to arrive, and the pause before the one more try of a download that failed. */
const DOWNLOAD_TIMEOUT_MS = 30_000;
const RETRY_PAUSE_MS = 400;

/** Downloads and caches decoded-on-GPU field images (ImageBitmaps of the rg16 PNGs). */
@Injectable({ providedIn: 'root' })
export class FieldLoaderService {
  private static readonly MAX_CACHED = 96; // ~390 KB each once decoded (296 x 326 cells x 4 bytes), so about 37 MB at most

  private readonly catalog = inject(ForecastCatalogService);
  private readonly cache = new Map<string, ImageBitmap>();
  private readonly inflight = new Map<string, Promise<ImageBitmap>>();
  /** Levels ("model/run.build/800") whose published pictures hold no data, so they are worked out from the levels either side (see fetchField). */
  private readonly emptyLevels = new Set<string>();

  /** How many pictures are held, decoded, in memory now (the performance meter shows it). */
  get cached(): number {
    return this.cache.size;
  }

  /** Cache key; includes model, run and build so a new run, a rebuilt run or another model never reuses old pixels. */
  static key(model: string, run: string, varId: string, stepHour: number, build = ''): string {
    return `${model}/${run}${build ? `.${build}` : ''}/${varId}/${stepHour}`;
  }

  /**
   * One picture. `priority` is the browser's hint for the download: the map's own pictures are asked for as they are (auto), the ones the
   * place card reads in the background as 'low', so on a slow connection the map comes first. A picture already on its way keeps the
   * priority it was first asked for with.
   */
  get(varId: string, stepHour: number, priority: 'auto' | 'low' = 'auto'): Promise<ImageBitmap> {
    const manifest = this.catalog.manifest();
    if (!manifest) return Promise.reject(new Error('forecast manifest not loaded'));
    const run = manifest.run;
    const key = FieldLoaderService.key(manifest.model, run, varId, stepHour, manifest.build);

    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU order
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      const load = this.catalog.isSynthesizedVar?.(varId) || this.emptyLevels.has(this.emptyKey(manifest, varId))
        ? this.interpolateLevelBitmap(manifest, varId, stepHour, priority)
        : this.fetchField(manifest, varId, stepHour, priority);
      pending = load.then(bmp => {
        this.cache.set(key, bmp);
        this.evict();
        return bmp;
      });
      pending.catch(() => undefined).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  /** Warm the cache; failures are ignored. */
  prefetch(varId: string, stepHours: number[]): void {
    for (const h of stepHours) this.get(varId, h).catch(() => undefined);
  }

  private emptyKey(manifest: ForecastManifest, varId: string): string {
    return `${manifest.model}/${manifest.run}.${manifest.build ?? ''}/${varId.replace(/^[a-z]+/, '')}`;
  }

  /**
   * One picture as published. The pipeline lists 800 and 600 hPa for every model, but a source that has no such level (ECMWF's open data
   * has no 800 hPa) came out as a picture with no data in any cell. That level is worked out from the levels either side instead, as
   * when the manifest has none, and remembered, so the rest of the run's pictures of it do not ask for the empty ones.
   */
  private async fetchField(manifest: ForecastManifest, varId: string, stepHour: number, priority: 'auto' | 'low'): Promise<ImageBitmap> {
    const bitmap = await this.fetchBitmap(this.catalog.fieldUrl(varId, stepHour, manifest.run, manifest.build), priority);
    const near = levelNeighbours(varId);
    const info = manifest.vars[varId];
    if (!near || !info || !manifest.vars[near.belowId] || !manifest.vars[near.aboveId]) return bitmap;
    if (!isEmptyField(decodeFieldBitmap(bitmap, info.min, info.max))) return bitmap;
    this.emptyLevels.add(this.emptyKey(manifest, varId));
    bitmap.close();
    return this.interpolateLevelBitmap(manifest, varId, stepHour, priority);
  }

  /** Interpolates an 800 hPa (from 850 & 700 hPa) or 600 hPa (from 700 & 500 hPa) field bitmap linearly in ln(p). */
  private async interpolateLevelBitmap(manifest: ForecastManifest, varId: string, stepHour: number, priority: 'auto' | 'low'): Promise<ImageBitmap> {
    const near = levelNeighbours(varId);
    if (!near) throw new Error(`Unsupported synthesized variable ${varId}`);
    const { belowId, aboveId, mix } = near;
    const belowInfo = manifest.vars[belowId];
    const aboveInfo = manifest.vars[aboveId];
    const targetInfo = manifest.vars[varId];
    const [bmpBelow, bmpAbove] = await Promise.all([this.get(belowId, stepHour, priority), this.get(aboveId, stepHour, priority)]);
    const fieldBelow = decodeFieldBitmap(bmpBelow, belowInfo.min, belowInfo.max);
    const fieldAbove = decodeFieldBitmap(bmpAbove, aboveInfo.min, aboveInfo.max);
    const blended = blendFields(fieldBelow, fieldAbove, mix);
    return encodeFieldBitmap(blended, manifest.grid, targetInfo.min, targetInfo.max);
  }

  /**
   * One download, tried once more when the connection failed or timed out, or the server answered with an error of its own (a 5xx).
   * A picture that never comes leaves whatever is worked out from it on the numbers of the time or period before.
   */
  private async download(url: string, priority: 'auto' | 'low'): Promise<Response> {
    const attempt = () => {
      const init: RequestInit = {};
      if (priority === 'low') init.priority = 'low';
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') init.signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
      return fetch(url, init);
    };
    try {
      const res = await attempt();
      if (res.status < 500) return res;
    } catch {
      // the second try below
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_PAUSE_MS));
    return attempt();
  }

  private async fetchBitmap(url: string, priority: 'auto' | 'low'): Promise<ImageBitmap> {
    const res = await this.download(url, priority);
    if (!res.ok) {
      // A 404 usually means a newer run replaced this one; re-read latest.json so the next call recovers.
      if (res.status === 404) void this.catalog.refresh();
      throw new Error(`${res.status} ${url}`);
    }
    // premultiplyAlpha/colorSpace 'none' keep the packed bytes exactly as encoded.
    return createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  }

  private evict(): void {
    while (this.cache.size > FieldLoaderService.MAX_CACHED) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.get(oldest)?.close();
      this.cache.delete(oldest);
    }
  }
}
