import { Injectable, signal } from '@angular/core';
import { decodeFieldBitmap } from './field-decode';
import { FORECAST_MODELS, ForecastModelDef } from './forecast-models';
import { ForecastGrid, ForecastManifest, fetchFieldResponse } from './forecast.model';
import { INDIA_GRID, extremeConsensus, resampleField } from './derived-fields';

/** How far from a step a time may be for a model to count (the 6-hourly models are 3 h from their nearest step at worst). */
const MAX_GAP_MS = 3.5 * 3_600_000;
const MANIFEST_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED_FIELDS = 40;

export interface Consensus {
  /** The 24 h rain probability (0..100%) that the models agree on, on `grid`. */
  values: Float32Array;
  /** The models that took part: the ones whose run covers the time. */
  models: string[];
  /** Grid of `values` (Global 0.25° when global models are active, or INDIA_GRID). */
  grid: ForecastGrid;
}

interface Published {
  run: string;
  build: string | undefined;
  manifest: ForecastManifest;
  at: number;
}

/**
 * The extreme-rain layer: multi-model agreement on the next 24 h of rain (`rain24`), mapped continuously onto the 0..100%
 * probability scale so heavy-rain zones render with smooth Windy-style contours.
 */
@Injectable({ providedIn: 'root' })
export class ConsensusService {
  /** The models that agreed in the last answer, for the legend. */
  readonly models = signal<string[]>([]);
  /** The last answer, for the click card. */
  last: Consensus | null = null;

  private readonly published = new Map<string, Published>();
  private readonly fields = new Map<string, { values: Float32Array; grid: ForecastGrid }>();

  async compute(timeMs: number): Promise<Consensus | null> {
    const parts = await Promise.all(FORECAST_MODELS.map(m => this.rain24Field(m, timeMs).catch(() => null)));
    const used = parts.flatMap((p, i) => (p ? [{ label: FORECAST_MODELS[i].label, values: p.values, grid: p.grid }] : []));
    if (used.length < 2) {
      this.models.set([]);
      this.last = null;
      return null;
    }
    const targetGrid = used.find(u => u.grid.nx > 500)?.grid ?? INDIA_GRID;
    const aligned = used.map(u => resampleField(u.values, u.grid, targetGrid));
    const result: Consensus = { values: extremeConsensus(aligned, targetGrid), models: used.map(u => u.label), grid: targetGrid };
    this.models.set(result.models);
    this.last = result;
    return result;
  }

  /** One model's 24 h rainfall field (mm) at a time on its grid, or null when the model does not cover it. */
  private async rain24Field(model: ForecastModelDef, timeMs: number): Promise<{ values: Float32Array; grid: ForecastGrid } | null> {
    const p = await this.newest(model);
    const info = p.manifest.vars['rain24'];
    if (!info) return null;
    let best: { h: number; gap: number } | null = null;
    for (const s of p.manifest.steps) {
      const gap = Math.abs(Date.parse(s.valid) - timeMs);
      if (!best || gap < best.gap) best = { h: s.h, gap };
    }
    if (!best || best.gap > MAX_GAP_MS) return null;
    const key = `${model.id}/${p.run}.${p.build ?? ''}/rain24/${best.h}`;
    const hit = this.fields.get(key);
    if (hit) return hit;
    const res = await fetchFieldResponse(model.baseUrl, p.manifest, 'rain24', best.h);
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const targetGrid = p.manifest.grid.nx > 500 ? p.manifest.grid : INDIA_GRID;
    const values = resampleField(decodeFieldBitmap(bitmap, info.min, info.max), p.manifest.grid, targetGrid);
    bitmap.close();
    const entry = { values, grid: targetGrid };
    this.fields.set(key, entry);
    while (this.fields.size > MAX_CACHED_FIELDS) this.fields.delete(this.fields.keys().next().value!);
    return entry;
  }

  /** The newest run of a model (its latest.json and manifest), kept for ten minutes. */
  private async newest(model: ForecastModelDef): Promise<Published> {
    const have = this.published.get(model.id);
    if (have && Date.now() - have.at < MANIFEST_TTL_MS) return have;
    let resolvedBase = model.baseUrl;
    let latest: { run: string; build?: string };
    try {
      const r = await fetch(`${model.baseUrl}/latest.json`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`${r.status}`);
      latest = (await r.json()) as { run: string; build?: string };
    } catch (err) {
      if (!model.fallbackBaseUrl) throw err;
      resolvedBase = model.fallbackBaseUrl;
      latest = (await (await fetch(`${resolvedBase}/latest.json`, { cache: 'no-cache' })).json()) as { run: string; build?: string };
    }
    if (have && have.run === latest.run && have.build === latest.build && have.manifest.baseUrl === resolvedBase) {
      have.at = Date.now();
      return have;
    }
    const url = `${resolvedBase}/${latest.run}/manifest.json${latest.build ? `?b=${encodeURIComponent(latest.build)}` : ''}`;
    const manifest = (await (await fetch(url)).json()) as ForecastManifest;
    manifest.baseUrl = resolvedBase;
    const fresh: Published = { run: latest.run, build: latest.build, manifest, at: Date.now() };
    this.published.set(model.id, fresh);
    return fresh;
  }
}
