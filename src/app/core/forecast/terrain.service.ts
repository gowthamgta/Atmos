import { Injectable, signal } from '@angular/core';
import { ForecastGrid, gridPosition } from './forecast.model';
import { PointTerrain, terrainDelta } from './terrain-correction';
import { TerrainLevel, sampleTile, tileNameAt } from './terrain-tiles';
import { PAGES } from './forecast-models';

/** The terrain files, published with the forecast data on GitHub Pages (written by pipeline/build_terrain.py). */
export const TERRAIN_BASE = `${PAGES}/terrain`;

/** Contents of terrain/index.json, written by pipeline/build_terrain.py. */
export interface TerrainMeta {
  domain: { latMax: number; latMin: number; lonMin: number; lonMax: number };
  tileDeg: number;
  levels: { id: number; perDeg: number; dir: string }[];
  /** Tiles that have ground (their 270 m and 1.08 km files). A tile not listed is open sea. */
  tiles: string[];
  /** Tiles with a 90 m file: South India only (absent in older builds, where every tile has one). */
  tilesL0?: string[];
  min: number;
  max: number;
  /** The ground smoothed over ~4 km (R,G metres, B unused). */
  smooth: ForecastGrid & { file: string };
  /** The forecast grid the terrain is sampled on, and the ground each model resolution sees (km -> file). */
  grid: ForecastGrid;
  model: Record<string, string>;
  source: string;
}

export interface TerrainData {
  meta: TerrainMeta;
  smooth: ImageBitmap;
  /** The ground as each model sees it, by native grid (km). */
  models: Map<number, ImageBitmap>;
  /** A 90 m, 270 m or 1.08 km tile (see TerrainService.tileImage). */
  tileImage: (level: TerrainLevel, name: string) => Promise<ImageBitmap>;
}

const M_PER_DEG = 111_200;
/** Decoded tiles kept in memory for the click card (about 6 MB each as RGBA at 90 m, less at 270 m). */
const CPU_TILE_CACHE = 6;

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

/** A decoded 90 m tile, kept in memory for the click card. */
interface CpuTile {
  rgba: Uint8ClampedArray;
  n: number;
}

/**
 * Loads the terrain once: the index, the smoothed ground and the model-ground grids (all small). The 90 m tiles load on
 * demand: the map asks for the tiles on screen (see ScalarFieldLayer), and the click card for the one under the cursor.
 */
@Injectable({ providedIn: 'root' })
export class TerrainService {
  readonly data = signal<TerrainData | null>(null);
  private loading: Promise<TerrainData> | null = null;
  private readonly cpuTiles = new Map<string, CpuTile>();
  private readonly cpuLoading = new Map<string, Promise<void>>();
  private present: ReadonlySet<string> = new Set();
  /** Tiles with a 90 m file (see TerrainMeta.tilesL0). */
  private presentL0: ReadonlySet<string> = new Set();

  ensureLoaded(): Promise<TerrainData> {
    const have = this.data();
    if (have) return Promise.resolve(have);
    this.loading ??= this.load().catch(err => {
      this.loading = null; // allow a retry on the next request
      throw err;
    });
    return this.loading;
  }

  /** Whether a tile has ground in it (a tile without ground is open sea). Needs the terrain loaded. */
  hasTile(name: string): boolean {
    return this.present.has(name);
  }

  /** Tile names with ground, once the terrain is loaded. */
  tileNames(): ReadonlySet<string> {
    return this.present;
  }

  /** A 90 m, 270 m or 1.08 km tile as an image (metres in R,G; land in B). */
  async tileImage(level: TerrainLevel, name: string): Promise<ImageBitmap> {
    const res = await this.ok(fetch(`${TERRAIN_BASE}/L${level}/${name}.webp`));
    return createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  }

  /** Model-ground image for a model whose native grid is `gridKm` km. */
  modelGround(data: TerrainData, gridKm: number): { km: number; bitmap: ImageBitmap } {
    const km = nearestModelKm([...data.models.keys()], gridKm);
    return { km, bitmap: data.models.get(km)! };
  }

  /**
   * The ground at a point as the corrections need it, from the 90 m tile under it. Null until the terrain and that tile
   * have loaded, or outside the domain: the model's own values are then shown (see prepareAt, which loads the tile).
   */
  pointTerrain(lat: number, lon: number, gridKm: number): PointTerrain | null {
    const t = this.data();
    if (!t) return null;
    const { domain, min, max, smooth: smoothGrid, grid } = t.meta;
    if (lat > domain.latMax || lat < domain.latMin || lon < domain.lonMin || lon > domain.lonMax) return null;
    const name = tileNameAt(lat, lon);
    const cpu = this.cpuTiles.get(name);
    if (!cpu) {
      void this.prepareAt(lat, lon);
      return null;
    }
    const model = this.modelGround(t, gridKm).bitmap;
    // position inside the tile: distances from its north and west edges, in degrees
    const dLat = Math.floor(lat) + 1 - lat;
    const dLon = lon - Math.floor(lon);
    const fine = sampleTile(cpu.rgba, cpu.n, dLat, dLon, max);
    const m = sampleTerrain(model, grid, lat, lon, min, max);
    const sm = sampleTerrain(t.smooth, smoothGrid, lat, lon, min, max);
    // slope of the 90 m ground over two cells either side (a neighbour outside the tile is clamped to its edge)
    const step = 2 / cpu.n;
    const zE = sampleTile(cpu.rgba, cpu.n, dLat, dLon + step, max).z;
    const zW = sampleTile(cpu.rgba, cpu.n, dLat, dLon - step, max).z;
    const zN = sampleTile(cpu.rgba, cpu.n, dLat - step, dLon, max).z;
    const zS = sampleTile(cpu.rgba, cpu.n, dLat + step, dLon, max).z;
    const dx = 2 * step * M_PER_DEG * Math.cos((lat * Math.PI) / 180);
    const dy = 2 * step * M_PER_DEG;
    return {
      fine: fine.z,
      model: m.z,
      dz: terrainDelta(fine.z, m.z),
      tpi: fine.z - sm.z,
      landFine: fine.land,
      landModel: m.land,
      slope: slopeOf(t.smooth, smoothGrid, lat, lon, min, max),
      modelSlope: slopeOf(model, grid, lat, lon, min, max),
      fineSlope: [(zE - zW) / dx, (zN - zS) / dy],
    };
  }

  /**
   * Loads the tile under a point for the click card (no-op when it is loaded or is sea): the 90 m file where there is one,
   * else the 270 m file, so the card reads the same ground the map draws.
   */
  prepareAt(lat: number, lon: number): Promise<void> {
    const name = tileNameAt(lat, lon);
    if (this.cpuTiles.has(name) || !this.present.has(name)) return Promise.resolve();
    const running = this.cpuLoading.get(name);
    if (running) return running;
    const load = this.tileImage(this.presentL0.has(name) ? 0 : 1, name)
      .then(bitmap => {
        const canvas: OffscreenCanvas | HTMLCanvasElement =
          typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bitmap.width, bitmap.height) : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
        const c = canvas.getContext('2d', { willReadFrequently: true }) as Canvas2D;
        c.drawImage(bitmap, 0, 0);
        const n = bitmap.width;
        const rgba = c.getImageData(0, 0, n, bitmap.height).data;
        bitmap.close();
        if (this.cpuTiles.size >= CPU_TILE_CACHE) this.cpuTiles.delete(this.cpuTiles.keys().next().value!);
        this.cpuTiles.set(name, { rgba, n });
      })
      .catch(err => console.warn('[terrain] tile unavailable', name, err))
      .finally(() => this.cpuLoading.delete(name));
    this.cpuLoading.set(name, load);
    return load;
  }

  private async load(): Promise<TerrainData> {
    const meta = (await (await this.ok(fetch(`${TERRAIN_BASE}/index.json`))).json()) as TerrainMeta;
    const image = async (name: string) =>
      createImageBitmap(await (await this.ok(fetch(`${TERRAIN_BASE}/${name}`))).blob(), {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
    const kms = Object.keys(meta.model).map(Number);
    const [smooth, ...models] = await Promise.all([meta.smooth.file, ...kms.map(km => meta.model[String(km)])].map(image));
    this.present = new Set(meta.tiles);
    this.presentL0 = new Set(meta.tilesL0 ?? meta.tiles);
    const data: TerrainData = {
      meta,
      smooth,
      models: new Map(kms.map((km, i) => [km, models[i]])),
      tileImage: (level, name) => this.tileImage(level, name),
    };
    this.data.set(data);
    return data;
  }

  private async ok(pending: Promise<Response>): Promise<Response> {
    const res = await pending;
    if (!res.ok) throw new Error(`${res.status} ${res.url}`);
    return res;
  }
}

