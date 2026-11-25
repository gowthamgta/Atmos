import { Injectable } from '@angular/core';
import { ForecastManifest } from './forecast.model';
import { GLOBAL_MODEL_DEF } from './forecast-models';

/**
 * Loads the 25 km worldwide surface forecast (`global` on GitHub Pages) for areas outside South India.
 * Silently returns null if the global run is not yet published.
 */
@Injectable({ providedIn: 'root' })
export class GlobalForecastService {
  private manifestPromise: Promise<ForecastManifest | null> | null = null;
  private manifest: ForecastManifest | null = null;
  private readonly bitmaps = new Map<string, Promise<ImageBitmap | null>>();
  private static readonly MAX_BITMAPS = 40;

  ensureManifest(): Promise<ForecastManifest | null> {
    if (this.manifest) return Promise.resolve(this.manifest);
    this.manifestPromise ??= this.loadManifest();
    return this.manifestPromise;
  }

  currentManifest(): ForecastManifest | null {
    return this.manifest;
  }

  private async loadManifest(): Promise<ForecastManifest | null> {
    try {
      const latestRes = await fetch(`${GLOBAL_MODEL_DEF.baseUrl}/latest.json`);
      if (!latestRes.ok) return null;
      const latest = (await latestRes.json()) as { run?: string };
      if (!latest.run) return null;
      const manRes = await fetch(`${GLOBAL_MODEL_DEF.baseUrl}/${latest.run}/manifest.json`);
      if (!manRes.ok) return null;
      const man = (await manRes.json()) as ForecastManifest;
      this.manifest = man;
      return man;
    } catch {
      return null;
    }
  }

  getField(varId: string, hour: number): Promise<ImageBitmap | null> {
    const man = this.manifest;
    if (!man || !man.vars[varId]) return Promise.resolve(null);
    const key = `${man.run}/${varId}/${hour}`;
    const existing = this.bitmaps.get(key);
    if (existing) return existing;

    const hStr = String(hour).padStart(3, '0');
    const url = `${GLOBAL_MODEL_DEF.baseUrl}/${man.run}/${varId}/${hStr}.png?v=${encodeURIComponent(man.build ?? '')}`;
    const pending = fetch(url)
      .then(async res => {
        if (!res.ok) return null;
        return createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      })
      .catch(() => null);

    if (this.bitmaps.size >= GlobalForecastService.MAX_BITMAPS) {
      this.bitmaps.delete(this.bitmaps.keys().next().value!);
    }
    this.bitmaps.set(key, pending);
    return pending;
  }
}
