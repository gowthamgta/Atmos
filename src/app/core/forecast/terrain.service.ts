import { Injectable, signal } from '@angular/core';
import { sampleRg16Bitmap } from './bitmap-sampler';
import { ForecastGrid } from './forecast.model';
import { terrainDelta } from './terrain-correction';

/** Contents of public/data/sa-terrain.json, written by scripts/build-south-india-data.py. */
export interface TerrainMeta {
  fine: ForecastGrid;
  /** The terrain averaged onto the forecast grid: what the model "thinks" the ground height is. */
  model: ForecastGrid;
  min: number;
  max: number;
}

export interface TerrainData {
  meta: TerrainMeta;
  fine: ImageBitmap;
  model: ImageBitmap;
}

/** Loads the static 1 km terrain once, for the GPU correction and for click inspection. */
@Injectable({ providedIn: 'root' })
export class TerrainService {
  readonly data = signal<TerrainData | null>(null);
  private loading: Promise<TerrainData> | null = null;

  ensureLoaded(): Promise<TerrainData> {
    const have = this.data();
    if (have) return Promise.resolve(have);
    this.loading ??= this.load().catch(err => {
      this.loading = null; // allow a retry on the next request
      throw err;
    });
    return this.loading;
  }

  /** Terrain heights at a point and their difference; null until the terrain has loaded. */
  heightsAt(lat: number, lon: number): { fine: number; model: number; delta: number } | null {
    const t = this.data();
    if (!t) return null;
    const fine = sampleRg16Bitmap(t.fine, t.meta.fine, lat, lon, t.meta.min, t.meta.max);
    const model = sampleRg16Bitmap(t.model, t.meta.model, lat, lon, t.meta.min, t.meta.max);
    if (Number.isNaN(fine) || Number.isNaN(model)) return null;
    return { fine, model, delta: terrainDelta(fine, model) };
  }

  private async load(): Promise<TerrainData> {
    const meta = (await (await this.ok(fetch('/data/sa-terrain.json'))).json()) as TerrainMeta;
    const image = async (name: string) =>
      createImageBitmap(await (await this.ok(fetch(`/data/${name}`))).blob(), {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
    const [fine, model] = await Promise.all([image('sa-elevation-1km.png'), image('sa-model-elevation.png')]);
    const data = { meta, fine, model };
    this.data.set(data);
    return data;
  }

  private async ok(pending: Promise<Response>): Promise<Response> {
    const res = await pending;
    if (!res.ok) throw new Error(`${res.status} ${res.url}`);
    return res;
  }
}
