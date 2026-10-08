/**
 * The 90 m terrain, in 1 x 1 degree tiles (written by pipeline/build_terrain.py). Only the tiles on screen are held on the
 * GPU: a fixed number of slots per detail level, least recently used first out. Pure functions and one small class, so the
 * rules can be tested without a browser.
 */

/** Tile-map value for a tile with no ground file: open sea (0 m, no land). */
export const TILE_SEA = 254;
/** Tile-map value for a tile that is not on the GPU (yet): the fine terrain is not used there. */
export const TILE_NONE = 255;

/** Detail levels, from full resolution (90 m) to the coarsest (1.08 km). */
export type TerrainLevel = 0 | 1 | 2;

/**
 * The detail level for a map zoom. Full 90 m tiles only when the screen pixels are about that size (zoomed in: 90 m is
 * visible). Zoomed out, the 270 m copy is used down to zoom 5 (a screen pixel is then about 2.4 km, so 270 m cells still
 * give the ridges their true heights); the 1.08 km copy only further out, where the whole domain is a few hundred pixels.
 */
export function terrainLevelForZoom(zoom: number): TerrainLevel {
  if (zoom >= 9.5) return 0;
  if (zoom >= 5) return 1;
  return 2;
}

/** Tiles held on the GPU at once, per level (the 90 m level is the largest: about 1.2k x 1.2k cells each). */
export const TILE_SLOTS: Record<TerrainLevel, number> = { 0: 20, 1: 56, 2: 56 };

/** The tile that holds a point: its south-west corner, e.g. N11E078 for 11.74 N, 78.96 E. */
export function tileNameAt(lat: number, lon: number): string {
  return tileName(Math.floor(lat), Math.floor(lon));
}

export function tileName(latSw: number, lonSw: number): string {
  return `N${String(latSw).padStart(2, '0')}E${String(lonSw).padStart(3, '0')}`;
}

/** Where the tile grid sits: tile column 0 starts at lonMin, tile row 0 at the top (latTop); rows and columns of tiles. */
export interface TileGrid {
  lonMin: number;
  latTop: number;
  cols: number;
  rows: number;
}

/** The tile grid of a domain: whole degrees around it. */
export function tileGridOf(domain: { latMax: number; latMin: number; lonMin: number; lonMax: number }): TileGrid {
  const lonMin = Math.floor(domain.lonMin);
  const latTop = Math.ceil(domain.latMax);
  return {
    lonMin,
    latTop,
    cols: Math.ceil(domain.lonMax) - lonMin,
    rows: latTop - Math.floor(domain.latMin),
  };
}

/** The tile at grid column `col` and row `row` (row 0 is the northernmost). */
export function tileAtCell(grid: TileGrid, col: number, row: number): string {
  return tileName(grid.latTop - 1 - row, grid.lonMin + col);
}

/** Names of the tiles that a view of the given bounds touches (only those that exist: the others are open sea). */
export function tilesInBounds(
  grid: TileGrid,
  bounds: { west: number; south: number; east: number; north: number },
  present: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const c0 = Math.max(0, Math.floor(bounds.west) - grid.lonMin);
  const c1 = Math.min(grid.cols - 1, Math.floor(bounds.east) - grid.lonMin);
  const r0 = Math.max(0, grid.latTop - 1 - Math.floor(bounds.north) + 0);
  const r1 = Math.min(grid.rows - 1, grid.latTop - 1 - Math.floor(bounds.south));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const name = tileAtCell(grid, c, r);
      if (present.has(name)) out.push(name);
    }
  }
  return out;
}

/**
 * Which tile slot each grid cell reads (the shader's tile map, one byte per 1 x 1 degree tile, row-major, row 0 north):
 * a slot number when the tile is on the GPU, TILE_SEA for open sea, TILE_NONE when the tile is not on the GPU.
 */
export function buildTileMap(grid: TileGrid, present: ReadonlySet<string>, slots: ReadonlyMap<string, number>): Uint8Array {
  const map = new Uint8Array(grid.cols * grid.rows);
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const name = tileAtCell(grid, c, r);
      const i = r * grid.cols + c;
      if (!present.has(name)) map[i] = TILE_SEA;
      else map[i] = slots.get(name) ?? TILE_NONE;
    }
  }
  return map;
}

/**
 * Slots on the GPU for one detail level: a tile keeps its slot while it stays on screen; a new tile takes a free slot,
 * or the least recently used tile that is not on screen now. Tiles on screen are never thrown out.
 */
export class TileSlots {
  private readonly slotOf = new Map<string, number>();
  private readonly nameOf: (string | null)[];
  private readonly used = new Map<string, number>();
  private clock = 0;

  constructor(readonly capacity: number) {
    this.nameOf = new Array<string | null>(capacity).fill(null);
  }

  has(name: string): boolean {
    return this.slotOf.has(name);
  }

  slot(name: string): number | undefined {
    return this.slotOf.get(name);
  }

  /** All tiles that hold a slot. */
  resident(): ReadonlyMap<string, number> {
    return this.slotOf;
  }

  /** Marks tiles as in use now (the ones on screen). */
  touch(names: readonly string[]): void {
    this.clock++;
    for (const n of names) if (this.slotOf.has(n)) this.used.set(n, this.clock);
  }

  /**
   * The slot for a tile about to be loaded, or null when every slot holds a tile that is on screen (the tile then stays
   * out, and the fine terrain is not used there). `onScreen` are the tiles that must keep their slots.
   */
  assign(name: string, onScreen: ReadonlySet<string>): number | null {
    const existing = this.slotOf.get(name);
    if (existing !== undefined) return existing;
    let slot = this.nameOf.indexOf(null);
    if (slot < 0) {
      let victim: string | null = null;
      let oldest = Infinity;
      for (const n of this.slotOf.keys()) {
        if (onScreen.has(n)) continue;
        const t = this.used.get(n) ?? 0;
        if (t < oldest) {
          oldest = t;
          victim = n;
        }
      }
      if (victim === null) return null;
      slot = this.slotOf.get(victim)!;
      this.slotOf.delete(victim);
      this.used.delete(victim);
    }
    this.nameOf[slot] = name;
    this.slotOf.set(name, slot);
    this.used.set(name, this.clock);
    return slot;
  }

  clear(): void {
    this.slotOf.clear();
    this.used.clear();
    this.nameOf.fill(null);
  }
}

/** Metres and land fraction from a tile pixel's bytes (R, G: 16-bit metres over 0..max; B: land fraction). */
export function decodeTilePixel(r: number, g: number, b: number, max: number): { z: number; land: number } {
  return { z: ((r * 256 + g) / 65535) * max, land: b / 255 };
}

/**
 * Bilinear metres and land fraction inside one tile, from its RGBA bytes (n x n pixels, row 0 north). The point is given
 * in degrees inside the tile: `dLat` and `dLon` are its distance from the tile's north and west edges.
 */
export function sampleTile(
  rgba: Uint8ClampedArray,
  n: number,
  dLat: number,
  dLon: number,
  max: number,
): { z: number; land: number } {
  const x = Math.min(Math.max(dLon * n - 0.5, 0), n - 1);
  const y = Math.min(Math.max(dLat * n - 0.5, 0), n - 1);
  const x0 = Math.min(Math.floor(x), n - 2);
  const y0 = Math.min(Math.floor(y), n - 2);
  const fx = x - x0;
  const fy = y - y0;
  let z = 0;
  let land = 0;
  for (let k = 0; k < 4; k++) {
    const ox = k & 1;
    const oy = k >> 1;
    const i = ((y0 + oy) * n + (x0 + ox)) * 4;
    const w = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
    const d = decodeTilePixel(rgba[i], rgba[i + 1], rgba[i + 2], max);
    z += d.z * w;
    land += d.land * w;
  }
  return { z, land };
}
