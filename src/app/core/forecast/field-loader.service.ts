import { Injectable, inject } from '@angular/core';
import { ForecastCatalogService } from './forecast-catalog.service';

/** Downloads and caches decoded-on-GPU field images (ImageBitmaps of the rg16 PNGs). */
@Injectable({ providedIn: 'root' })
export class FieldLoaderService {
  private static readonly MAX_CACHED = 96; // ~160 KB each, so about 15 MB at most

  private readonly catalog = inject(ForecastCatalogService);
  private readonly cache = new Map<string, ImageBitmap>();
  private readonly inflight = new Map<string, Promise<ImageBitmap>>();

  /** Cache key; includes model, run and build so a new run, a rebuilt run or another model never reuses old pixels. */
  static key(model: string, run: string, varId: string, stepHour: number, build = ''): string {
    return `${model}/${run}${build ? `.${build}` : ''}/${varId}/${stepHour}`;
  }

  get(varId: string, stepHour: number): Promise<ImageBitmap> {
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
      pending = this.fetchBitmap(this.catalog.fieldUrl(varId, stepHour, run, manifest.build)).then(bmp => {
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

  private async fetchBitmap(url: string): Promise<ImageBitmap> {
    const res = await fetch(url);
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
