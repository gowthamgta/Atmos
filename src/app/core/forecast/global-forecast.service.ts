import { Injectable } from '@angular/core';
import { blendFields, encodeFieldBitmap } from './derived-fields';
import { decodeFieldBitmap } from './field-decode';
import { levelNeighbours } from './field-loader.service';
import { synthesizeLevels } from './forecast-catalog.service';
import { ForecastManifest } from './forecast.model';
import { GLOBAL_MODEL_DEF } from './forecast-models';

/**
 * Loads the 25 km worldwide forecast (`global` on GitHub Pages) for areas outside South India,
 * including synthesizing 800 hPa linearly in ln(p) between 850 and 700 hPa.
 * Silently returns null if the global run is not yet published.
 */
@Injectable({ providedIn: 'root' })
export class GlobalForecastService {
  private manifestPromise: Promise<ForecastManifest | null> | null = null;
  private manifest: ForecastManifest | null = null;
  private synthesizedVars = new Set<string>();
  private readonly bitmaps = new Map<string, Promise<ImageBitmap | null>>();
  private static readonly MAX_BITMAPS = 64;

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
      this.synthesizedVars = new Set(synthesizeLevels(man));
      this.manifest = man;
      // Warm initial global temperature & surface winds immediately in parallel with regional loads
      const h0 = man.steps[0]?.h;
      if (h0 !== undefined) {
        void this.getField('t2m', h0);
        void this.getField('u10', h0);
        void this.getField('v10', h0);
      }
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

    const pending = this.synthesizedVars.has(varId)
      ? this.interpolateField(man, varId, hour)
      : this.fetchRawField(man, varId, hour);

    if (this.bitmaps.size >= GlobalForecastService.MAX_BITMAPS) {
      this.bitmaps.delete(this.bitmaps.keys().next().value!);
    }
    this.bitmaps.set(key, pending);
    return pending;
  }

  private fetchRawField(man: ForecastManifest, varId: string, hour: number): Promise<ImageBitmap | null> {
    const hStr = String(hour).padStart(3, '0');
    const url = `${GLOBAL_MODEL_DEF.baseUrl}/${man.run}/${varId}/${hStr}.png?v=${encodeURIComponent(man.build ?? '')}`;
    return fetch(url)
      .then(async res => {
        if (!res.ok) return null;
        return createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      })
      .catch(() => null);
  }

  private async interpolateField(man: ForecastManifest, varId: string, hour: number): Promise<ImageBitmap | null> {
    const near = levelNeighbours(varId);
    const targetInfo = man.vars[varId];
    if (!near || !targetInfo) return null;
    const belowInfo = man.vars[near.belowId];
    const aboveInfo = man.vars[near.aboveId];
    if (!belowInfo || !aboveInfo) return null;
    const [bmpBelow, bmpAbove] = await Promise.all([this.getField(near.belowId, hour), this.getField(near.aboveId, hour)]);
    if (!bmpBelow || !bmpAbove) return null;
    const blended = blendFields(decodeFieldBitmap(bmpBelow, belowInfo.min, belowInfo.max), decodeFieldBitmap(bmpAbove, aboveInfo.min, aboveInfo.max), near.mix);
    return encodeFieldBitmap(blended, man.grid, targetInfo.min, targetInfo.max);
  }
}
