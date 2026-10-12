import { Injectable, signal } from '@angular/core';
import { decodeFieldBitmap } from './field-decode';
import { FORECAST_MODELS, ForecastModelDef } from './forecast-models';
import { ForecastManifest } from './forecast.model';
import { INDIA_GRID, extremeConsensus, resampleField } from './derived-fields';

/** How far from a step a time may be for a model to count (the 6-hourly models are 3 h from their nearest step at worst). */
const MAX_GAP_MS = 3.5 * 3_600_000;
const MANIFEST_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED_FIELDS = 40;

export interface Consensus {
  /** The rain category (0 none, 1 heavy, 2 very heavy, 3 extremely heavy) that the models agree on, on the India grid. */
  values: Float32Array;
  /** The models that took part: the ones whose run covers the time. */
  models: string[];
}

interface Published {
  run: string;
  build: string | undefined;
  manifest: ForecastManifest;
  at: number;
}

/**
 * The extreme-rain layer: multi-model agreement on the next 24 h of rain (`rain24`), mapped continuously onto the 0..3
 * severity scale on the India grid so heavy-rain zones render with smooth Windy-style contours.
 */
@Injectable({ providedIn: 'root' })
export class ConsensusService {
  /** The models that agreed in the last answer, for the legend. */
  readonly models = signal<string[]>([]);
  /** The last answer, for the click card. */
  last: Consensus | null = null;

  private readonly published = new Map<string, Published>();
  private readonly fields = new Map<string, Float32Array>();

  async compute(timeMs: number): Promise<Consensus | null> {
    const parts = await Promise.all(FORECAST_MODELS.map(m => this.rain24Field(m, timeMs).catch(() => null)));
    const used = parts.flatMap((p, i) => (p ? [{ label: FORECAST_MODELS[i].label, values: p }] : []));
    if (used.length < 2) {
      this.models.set([]);
      this.last = null;
      return null;
    }
    const result: Consensus = { values: extremeConsensus(used.map(u => u.values), INDIA_GRID), models: used.map(u => u.label) };
    this.models.set(result.models);
    this.last = result;
    return result;
  }

  /** One model's 24 h rainfall field (mm) at a time on the India grid, or null when the model does not cover it. */
  private async rain24Field(model: ForecastModelDef, timeMs: number): Promise<Float32Array | null> {
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
    const url = `${model.baseUrl}/${p.run}/rain24/${String(best.h).padStart(3, '0')}.png${p.build ? `?b=${encodeURIComponent(p.build)}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const onIndia = resampleField(decodeFieldBitmap(bitmap, info.min, info.max), p.manifest.grid, INDIA_GRID);
    bitmap.close();
    this.fields.set(key, onIndia);
    while (this.fields.size > MAX_CACHED_FIELDS) this.fields.delete(this.fields.keys().next().value!);
    return onIndia;
  }

  /** The newest run of a model (its latest.json and manifest), kept for ten minutes. */
  private async newest(model: ForecastModelDef): Promise<Published> {
    const have = this.published.get(model.id);
    if (have && Date.now() - have.at < MANIFEST_TTL_MS) return have;
    const latest = (await (await fetch(`${model.baseUrl}/latest.json`, { cache: 'no-cache' })).json()) as { run: string; build?: string };
    if (have && have.run === latest.run && have.build === latest.build) {
      have.at = Date.now();
      return have;
    }
    const url = `${model.baseUrl}/${latest.run}/manifest.json${latest.build ? `?b=${encodeURIComponent(latest.build)}` : ''}`;
    const manifest = (await (await fetch(url)).json()) as ForecastManifest;
    const fresh: Published = { run: latest.run, build: latest.build, manifest, at: Date.now() };
    this.published.set(model.id, fresh);
    return fresh;
  }
}
