import { Injectable, signal } from '@angular/core';
import { ForecastGrid, gridPosition } from './forecast.model';
import { PointTerrain, insetWeight, terrainDelta } from './terrain-correction';

/** Contents of public/data/sa-terrain.json, written by scripts/build-south-india-data.py. */
export interface TerrainMeta {
  /** 1 km terrain (R,G metres, B land fraction). */
  fine: ForecastGrid;
  /** The terrain smoothed over ~4 km (R,G metres): the reference for ridges, valleys and windward slopes. */
  smooth: ForecastGrid;
  /** The ground as each model sees it, on the forecast grid (R,G metres, B land fraction); one image per resolution. */
  model: ForecastGrid;
  modelKms: number[];
  min: number;
  max: number;
}

export interface TerrainData {
  meta: TerrainMeta;
  fine: ImageBitmap;
  smooth: ImageBitmap;
  /** Model ground images by native resolution (km). */
  models: Map<number, ImageBitmap>;
  /** The 90 m Tamil Nadu inset (see scripts/build-tamil-nadu-dem.py), or null when the file is not there. */
  inset: { meta: ForecastGrid & { min: number; max: number }; bitmap: ImageBitmap } | null;
}

const M_PER_DEG = 111_200;

/** The model-ground resolution (km) closest to a model's native grid spacing. */
export function nearestModelKm(available: readonly number[], gridKm: number): number {
  return available.reduce((best, km) => (Math.abs(km - gridKm) < Math.abs(best - gridKm) ? km : best), available[0]);
}

/** Decodes a terrain pixel: metres from R,G (16 bits over [min, max]), land fraction from B. */
export function decodeTerrainPixel(r: number, g: number, b: number, min: number, max: number): { z: number; land: number } {
  return { z: min + ((r * 256 + g) / 65535) * (max - min), land: b / 255 };
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
let scratch: Canvas2D | null = null;

function context(): Canvas2D {
  if (!scratch) {
    const canvas: OffscreenCanvas | HTMLCanvasElement =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(2, 2) : Object.assign(document.createElement('canvas'), { width: 2, height: 2 });
    scratch = canvas.getContext('2d', { willReadFrequently: true }) as Canvas2D;
  }
  return scratch;
}

/** Bilinear height and land fraction of a terrain image at lat/lon (reads only the four surrounding pixels). */
function sampleTerrain(bitmap: ImageBitmap, grid: ForecastGrid, lat: number, lon: number, min: number, max: number): { z: number; land: number } {
  const p = gridPosition(grid, lat, lon);
  const x = Math.min(Math.max(p.x, 0), grid.nx - 1);
  const y = Math.min(Math.max(p.y, 0), grid.ny - 1);
  const x0 = Math.min(Math.floor(x), grid.nx - 2);
  const y0 = Math.min(Math.floor(y), grid.ny - 2);
  const fx = x - x0;
  const fy = y - y0;
  const c = context();
  c.clearRect(0, 0, 2, 2);
  c.drawImage(bitmap, x0, y0, 2, 2, 0, 0, 2, 2);
  const px = c.getImageData(0, 0, 2, 2).data;
  let z = 0;
  let land = 0;
  for (let k = 0; k < 4; k++) {
    const ox = k & 1;
    const oy = k >> 1;
    const o = k * 4;
    const w = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
    const d = decodeTerrainPixel(px[o], px[o + 1], px[o + 2], min, max);
    z += d.z * w;
    land += d.land * w;
  }
  return { z, land };
}

/** Slope (m/m, rising to the east and to the north) of a terrain image, by central differences one grid step apart. */
function slopeOf(bitmap: ImageBitmap, grid: ForecastGrid, lat: number, lon: number, min: number, max: number): [number, number] {
  const s = grid.step;
  const z = (la: number, lo: number) => sampleTerrain(bitmap, grid, la, lo, min, max).z;
  const dx = 2 * s * M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const dy = 2 * s * M_PER_DEG;
  return [(z(lat, lon + s) - z(lat, lon - s)) / dx, (z(lat + s, lon) - z(lat - s, lon)) / dy];
}

/** Loads the static terrain once, for the GPU downscaling and for click inspection. */
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

  /** Model-ground image for a model whose native grid is `gridKm` km. */
  modelGround(data: TerrainData, gridKm: number): { km: number; bitmap: ImageBitmap } {
    const km = nearestModelKm(data.meta.modelKms, gridKm);
    return { km, bitmap: data.models.get(km)! };
  }

  /** The ground at a point as the corrections need it; null until the terrain has loaded or outside the domain. */
  pointTerrain(lat: number, lon: number, gridKm: number): PointTerrain | null {
    const t = this.data();
    if (!t) return null;
    const { fine: fg, smooth: sg, model: mg, min, max } = t.meta;
    if (lat > fg.latMax || lat < fg.latMin || lon < fg.lonMin || lon > fg.lonMax) return null;
    const model = this.modelGround(t, gridKm).bitmap;
    const coarse = sampleTerrain(t.fine, fg, lat, lon, min, max);
    const m = sampleTerrain(model, mg, lat, lon, min, max);
    const sm = sampleTerrain(t.smooth, sg, lat, lon, min, max);
    // the 90 m inset where it covers the point, faded into the 1 km ground at its edge
    const inset = t.inset;
    const w = inset ? insetWeight(lat, lon, inset.meta) : 0;
    const fine = w > 0 && inset ? sampleTerrain(inset.bitmap, inset.meta, lat, lon, min, max) : coarse;
    const f = w > 0 && inset
      ? { z: coarse.z + (fine.z - coarse.z) * w, land: coarse.land + (fine.land - coarse.land) * w }
      : coarse;
    return {
      fine: f.z,
      model: m.z,
      dz: terrainDelta(f.z, m.z),
      tpi: f.z - sm.z,
      landFine: f.land,
      landModel: m.land,
      slope: slopeOf(t.smooth, sg, lat, lon, min, max),
      modelSlope: slopeOf(model, mg, lat, lon, min, max),
      fineSlope: w > 0.5 && inset ? slopeOf(inset.bitmap, inset.meta, lat, lon, min, max) : slopeOf(t.fine, fg, lat, lon, min, max),
    };
  }

  private async load(): Promise<TerrainData> {
    const meta = (await (await this.ok(fetch('/data/sa-terrain.json'))).json()) as TerrainMeta;
    const image = async (name: string) =>
      createImageBitmap(await (await this.ok(fetch(`/data/${name}`))).blob(), {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
    const [fine, smooth, ...models] = await Promise.all([
      image('sa-elevation-1km.png'),
      image('sa-elevation-smooth.png'),
      ...meta.modelKms.map(km => image(`sa-model-elevation-${km}km.png`)),
    ]);
    const inset = await this.loadInset();
    const data: TerrainData = { meta, fine, smooth, models: new Map(meta.modelKms.map((km, i) => [km, models[i]])), inset };
    this.data.set(data);
    return data;
  }

  /** The Tamil Nadu 90 m inset; a missing file leaves the 1 km terrain in place everywhere. */
  private async loadInset(): Promise<TerrainData['inset']> {
    try {
      const meta = (await (await this.ok(fetch('/data/tn-terrain.json'))).json()) as ForecastGrid & { min: number; max: number };
      const bitmap = await createImageBitmap(await (await this.ok(fetch('/data/tn-elevation-90m.webp'))).blob(), {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      return { meta, bitmap };
    } catch (err) {
      console.warn('[terrain] 90 m inset unavailable; using the 1 km terrain', err);
      return null;
    }
  }

  private async ok(pending: Promise<Response>): Promise<Response> {
    const res = await pending;
    if (!res.ok) throw new Error(`${res.status} ${res.url}`);
    return res;
  }
}
