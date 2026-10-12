import { Injectable, inject } from '@angular/core';
import { blendFields, encodeFieldBitmap } from './derived-fields';
import { decodeFieldBitmap } from './field-decode';
import { ForecastCatalogService } from './forecast-catalog.service';
import { ForecastManifest } from './forecast.model';

/** Downloads and caches decoded-on-GPU field images (ImageBitmaps of the rg16 PNGs). */
@Injectable({ providedIn: 'root' })
export class FieldLoaderService {
  private static readonly MAX_CACHED = 96; // ~390 KB each once decoded (296 x 326 cells x 4 bytes), so about 37 MB at most

  private readonly catalog = inject(ForecastCatalogService);
  private readonly cache = new Map<string, ImageBitmap>();
  private readonly inflight = new Map<string, Promise<ImageBitmap>>();

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
      const load = this.catalog.isSynthesizedVar?.(varId)
        ? this.interpolateLevelBitmap(manifest, varId, stepHour, priority)
        : this.fetchBitmap(this.catalog.fieldUrl(varId, stepHour, run, manifest.build), priority);
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

  /** Interpolates an 800 hPa (from 850 & 700 hPa) or 600 hPa (from 700 & 500 hPa) field bitmap linearly in ln(p). */
  private async interpolateLevelBitmap(manifest: ForecastManifest, varId: string, stepHour: number, priority: 'auto' | 'low'): Promise<ImageBitmap> {
    const m = /^([a-z]+)(800|600)$/.exec(varId);
    if (!m) throw new Error(`Unsupported synthesized variable ${varId}`);
    const [, kind, lvlStr] = m;
    const is800 = lvlStr === '800';
    const belowId = `${kind}${is800 ? 850 : 700}`;
    const aboveId = `${kind}${is800 ? 700 : 500}`;
    const mix = is800 ? Math.log(850 / 800) / Math.log(850 / 700) : Math.log(700 / 600) / Math.log(700 / 500);
    const belowInfo = manifest.vars[belowId];
    const aboveInfo = manifest.vars[aboveId];
    const targetInfo = manifest.vars[varId];
    const [bmpBelow, bmpAbove] = await Promise.all([this.get(belowId, stepHour, priority), this.get(aboveId, stepHour, priority)]);
    const fieldBelow = decodeFieldBitmap(bmpBelow, belowInfo.min, belowInfo.max);
    const fieldAbove = decodeFieldBitmap(bmpAbove, aboveInfo.min, aboveInfo.max);
    const blended = blendFields(fieldBelow, fieldAbove, mix);
    return encodeFieldBitmap(blended, manifest.grid, targetInfo.min, targetInfo.max);
  }

  private async fetchBitmap(url: string, priority: 'auto' | 'low'): Promise<ImageBitmap> {
    const res = await fetch(url, priority === 'low' ? { priority: 'low' } : undefined);
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
