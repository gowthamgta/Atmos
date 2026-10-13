import type { Map as MapLibreMap } from 'maplibre-gl';
import type { TerrainData } from '../forecast/terrain.service';
import { isPhone } from '../ui/device-profile';
import { TileGrid, TileSlots, buildTileMap, resampleTileRgb, terrainLevelForZoom, tileGridOf, tileSlots, tilesInBounds, type TerrainLevel } from '../forecast/terrain-tiles';

/**
 * The 90 m terrain on the GPU, shared by the layers that shade or correct by it (the forecast colours and the radar echoes).
 *
 * Only the 1 x 1 degree tiles on screen are held, in a texture array with a slot per tile at the detail level the zoom wants (see terrain-tiles.ts);
 * a texture saying which slot holds each tile lets a shader find the ground under a pixel. `TERRAIN_TILE_GLSL` is the shader side: put it above the
 * code that calls `tileTerrain` and `tileSlope`, with `precision lowp sampler2DArray;` at the top of the shader.
 */

/** Terrain images: metres = (R * 256 + G) / 65535 over u_demEnc, land fraction = B (no "no data" flag). */
export const TERRAIN_TILE_GLSL = `
uniform sampler2DArray u_tiles; // the 90 m terrain tiles held on the GPU at the detail level in use, one per layer
uniform sampler2D u_tileMap;    // which layer holds each 1 x 1 degree tile (see terrain-tiles.ts)
uniform ivec2 u_tileCount;      // tile columns and rows of the domain
uniform vec2 u_tileOrigin;      // lonMin of tile column 0, and the top (north) edge of tile row 0
uniform float u_tilePx;         // cells per degree at the detail level in use
uniform vec2 u_demEnc;          // terrain value range

const float M_PER_DEG = 111200.0;

float decode(vec4 c, vec2 enc) {
  float q = floor(c.r * 255.0 + 0.5) * 256.0 + floor(c.g * 255.0 + 0.5);
  return enc.x + q / 65535.0 * (enc.y - enc.x);
}

// The ground from the 90 m tiles held on the GPU: (metres, land fraction, 1). Open sea is 0 m with no land and counts as
// held. A tile that is not on the GPU, or lies outside the domain, gives (0, 0, 0): the caller then uses another ground.
vec3 tileTerrain(float lat, float lon) {
  vec2 d = vec2(lon - u_tileOrigin.x, u_tileOrigin.y - lat);
  ivec2 t = ivec2(floor(d));
  if (t.x < 0 || t.y < 0 || t.x >= u_tileCount.x || t.y >= u_tileCount.y) return vec3(0.0);
  int slot = int(texelFetch(u_tileMap, t, 0).r * 255.0 + 0.5);
  if (slot == 254) return vec3(0.0, 0.0, 1.0);   // open sea
  if (slot > 253) return vec3(0.0);              // not on the GPU
  vec2 g = clamp((d - vec2(t)) * u_tilePx - 0.5, vec2(0.0), vec2(u_tilePx - 1.0));
  vec2 fr = fract(g);
  ivec2 i0 = ivec2(floor(g));
  ivec2 hi = ivec2(u_tilePx) - 1;
  vec2 acc = vec2(0.0);
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    vec4 c = texelFetch(u_tiles, ivec3(clamp(i0 + o, ivec2(0), hi), slot), 0);
    float w = (o.x == 1 ? fr.x : 1.0 - fr.x) * (o.y == 1 ? fr.y : 1.0 - fr.y);
    acc += vec2(decode(c, u_demEnc), c.b) * w;
  }
  return vec3(acc, 1.0);
}

// Slope (m/m, rising east and north) of the 90 m ground over two cells either side; zero where a neighbour is not held.
vec2 tileSlope(float lat, float lon) {
  float s = 2.0 / u_tilePx;
  vec3 e = tileTerrain(lat, lon + s);
  vec3 w = tileTerrain(lat, lon - s);
  vec3 n = tileTerrain(lat + s, lon);
  vec3 so = tileTerrain(lat - s, lon);
  if (min(min(e.z, w.z), min(n.z, so.z)) < 0.5) return vec2(0.0);
  return vec2((e.x - w.x) / (2.0 * s * M_PER_DEG * cos(radians(lat))), (n.x - so.x) / (2.0 * s * M_PER_DEG));
}
`;

/** The uniform names that `TerrainTileGpu.setUniforms` sets: a layer adds them to its own list. */
export const TERRAIN_TILE_UNIFORMS = ['u_tiles', 'u_tileMap', 'u_tileCount', 'u_tileOrigin', 'u_tilePx', 'u_demEnc'];

/** Texture units the tile array and the tile map are bound to (the layers keep their own textures below these). */
export const TILE_ARRAY_UNIT = 12;
export const TILE_MAP_UNIT = 13;

/** Holds the 90 m tiles of the view on the GPU for one layer. Call attach/detach with the layer's onAdd/onRemove, update every frame. */
export class TerrainTileGpu {
  private map: MapLibreMap | null = null;
  private terrain: TerrainData | null = null;
  /** The 90 m tiles of the detail level in use, one per layer of a texture array (see update). */
  private tileTex: WebGLTexture | null = null;
  /** Which layer holds each 1 x 1 degree tile of the domain (one byte each; see buildTileMap). */
  private tileMapTex: WebGLTexture | null = null;
  private tileGrid: TileGrid | null = null;
  private tileLevel: TerrainLevel | null = null;
  private tilePx = 1;
  private slots: TileSlots | null = null;
  private tilesPending = new Set<string>();
  /** When a tile last failed to load: it is asked for again only after a pause (not on every frame). */
  private tilesFailedAt = new Map<string, number>();
  private static readonly TILE_RETRY_MS = 30_000;
  private tilesOnScreen = new Set<string>();
  private tileMapDirty = true;
  private presentCache: ReadonlySet<string> | null = null;
  private presentCacheFor: TerrainData | null = null;
  private l0For: TerrainData | null = null;
  private l0Set: ReadonlySet<string> | null = null;
  private blankTiles: WebGLTexture | null = null;

  /** `name` is how the layer is called in the console when a tile cannot be loaded. */
  constructor(private readonly name: string) {}

  /** The terrain in use (null: none). */
  get data(): TerrainData | null {
    return this.terrain;
  }

  /** Whether the tiles of the view can be read by a shader (a terrain is set and its tile array exists). */
  get ready(): boolean {
    return this.terrain !== null && this.tileTex !== null && this.tileGrid !== null;
  }

  attach(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.tileMapTex = gl.createTexture();
  }

  detach(gl: WebGL2RenderingContext): void {
    for (const tex of [this.tileMapTex, this.tileTex, this.blankTiles]) if (tex) gl.deleteTexture(tex);
    this.tileMapTex = this.tileTex = this.blankTiles = null;
    this.tilesFailedAt.clear();
    this.slots = null;
    this.tileLevel = null;
    this.map = null;
  }

  /** Provide (or clear) the terrain; new terrain drops the tiles held, and the next frame loads them again. */
  setTerrain(data: TerrainData | null, gl?: WebGL2RenderingContext | null): void {
    if (this.terrain !== data) this.reset(gl ?? null);
    this.terrain = data;
  }

  /**
   * Keeps the 90 m tiles on screen on the GPU: the detail level follows the zoom (see terrainLevelForZoom), each tile on
   * screen that is not held yet is loaded into a free slot, and the tile map is refreshed when a slot changes. A tile
   * that finds no slot (every slot holds a tile on screen) is not drawn: its pixels use the layer's other ground.
   */
  update(gl: WebGL2RenderingContext): void {
    const data = this.terrain;
    if (!data || !this.map) return;
    const level = terrainLevelForZoom(this.map.getZoom());
    if (level !== this.tileLevel || !this.tileTex) this.switchLevel(gl, data, level);
    if (!this.slots || !this.tileGrid) return;
    const b = this.map.getBounds();
    const bounds = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
    const visible = tilesInBounds(this.tileGrid, bounds, this.presentTiles(data));
    this.tilesOnScreen = new Set(visible);
    this.slots.touch(visible);
    for (const name of visible) {
      if (this.slots.has(name) || this.tilesPending.has(name) || this.recentlyFailed(name)) continue;
      this.loadTile(gl, data, name, level);
    }
    // the tiles just outside the view are loaded ahead of a pan, into free slots only: they never push out a tile on screen
    const ahead = tilesInBounds(this.tileGrid, { west: bounds.west - 1, south: bounds.south - 1, east: bounds.east + 1, north: bounds.north + 1 }, this.presentTiles(data));
    let free = this.slots.freeCount() - this.tilesPending.size;
    for (const name of ahead) {
      if (free <= 0) break;
      if (this.tilesOnScreen.has(name) || this.slots.has(name) || this.tilesPending.has(name) || this.recentlyFailed(name)) continue;
      this.loadTile(gl, data, name, level);
      free--;
    }
    if (this.tileMapDirty) this.uploadTileMap(gl);
  }

  /**
   * Binds the tile array (a blank one when `on` is false: the shader's tile sampler still reads a 2D-array texture) and, when on, the tile map.
   * The caller points `u_tiles` at TILE_ARRAY_UNIT, and `u_tileMap` at TILE_MAP_UNIT when on (else at unit 0).
   */
  bind(gl: WebGL2RenderingContext, on: boolean): void {
    gl.activeTexture(gl.TEXTURE0 + TILE_ARRAY_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, on && this.tileTex ? this.tileTex : this.blankTileArray(gl));
    if (on) {
      gl.activeTexture(gl.TEXTURE0 + TILE_MAP_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.tileMapTex);
    }
  }

  /** Sets the tile uniforms (see TERRAIN_TILE_GLSL) for a frame drawn with the tiles `on` or without them. */
  setUniforms(gl: WebGL2RenderingContext, u: Record<string, WebGLUniformLocation | null>, on: boolean): void {
    gl.uniform1i(u['u_tiles'], TILE_ARRAY_UNIT);          // always its own unit: a 2D-array texture is bound there
    gl.uniform1i(u['u_tileMap'], on ? TILE_MAP_UNIT : 0);
    const meta = this.terrain?.meta;
    if (on && meta && this.tileGrid) {
      gl.uniform2f(u['u_demEnc'], meta.min, meta.max);
      gl.uniform2i(u['u_tileCount'], this.tileGrid.cols, this.tileGrid.rows);
      gl.uniform2f(u['u_tileOrigin'], this.tileGrid.lonMin, this.tileGrid.latTop);
      gl.uniform1f(u['u_tilePx'], this.tilePx);
    } else {
      gl.uniform2i(u['u_tileCount'], 0, 0);
    }
  }

  // ── tiles ───────────────────────────────────────────────────────────────

  /** Drops the tiles on the GPU (new terrain): the next frame loads them again. */
  private reset(gl: WebGL2RenderingContext | null): void {
    if (gl && this.tileTex) gl.deleteTexture(this.tileTex);
    this.tilesFailedAt.clear();
    this.tileTex = null;
    this.tileLevel = null;
    this.slots = null;
    this.tilesPending.clear();
    this.tileMapDirty = true;
  }

  /** The tiles that have ground (a tile not in the list is open sea), read once per terrain. */
  private presentTiles(data: TerrainData): ReadonlySet<string> {
    if (this.presentCacheFor !== data) {
      this.presentCache = new Set(data.meta.tiles);
      this.presentCacheFor = data;
    }
    return this.presentCache!;
  }

  private recentlyFailed(name: string): boolean {
    const t = this.tilesFailedAt.get(name);
    return t !== undefined && performance.now() - t < TerrainTileGpu.TILE_RETRY_MS;
  }

  /** Whether a tile has its own 90 m file (South India); the others are drawn at 90 m from their 270 m file. */
  private hasL0(data: TerrainData, name: string): boolean {
    const list = data.meta.tilesL0;
    if (!list) return true;                       // an index without the list: every tile has a 90 m file
    if (this.l0For !== data) {
      this.l0Set = new Set(list);
      this.l0For = data;
    }
    return this.l0Set!.has(name);
  }

  /** A tile's 270 m image, resampled to the size of the 90 m level (see resampleTileRgb). */
  private async detailFromCoarse(coarse: ImageBitmap, maxM: number): Promise<ImageBitmap> {
    const n = coarse.width;
    const canvas = new OffscreenCanvas(n, n);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(coarse, 0, 0);
    const px = ctx.getImageData(0, 0, n, n).data;
    coarse.close();
    const m = this.tilePx;
    return createImageBitmap(new ImageData(resampleTileRgb(px, n, m, maxM), m, m));
  }

  /** A new detail level: a texture array with a slot per tile the level can hold on screen. */
  private switchLevel(gl: WebGL2RenderingContext, data: TerrainData, level: TerrainLevel): void {
    if (this.tileTex) gl.deleteTexture(this.tileTex);
    this.tilesPending.clear();
    this.tilesFailedAt.clear();
    this.tileLevel = level;
    this.tileGrid = tileGridOf(data.meta.domain);
    this.tilePx = data.meta.levels.find(l => l.id === level)?.perDeg ?? 1200;
    const slots = tileSlots(isPhone())[level];
    this.slots = new TileSlots(slots);
    this.tileTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tileTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, this.tilePx, this.tilePx, slots);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tileMapDirty = true;
  }

  /** Loads one tile and puts it in a free slot (if none is free, it is left out: see update). */
  private loadTile(gl: WebGL2RenderingContext, data: TerrainData, name: string, level: TerrainLevel): void {
    this.tilesPending.add(name);
    // the 90 m level where a tile has no 90 m file: its 270 m file, at the 90 m size
    const image = level === 0 && !this.hasL0(data, name)
      ? data.tileImage(1, name).then(coarse => this.detailFromCoarse(coarse, data.meta.max))
      : data.tileImage(level, name);
    image.then(bitmap => {
      this.tilesPending.delete(name);
      if (this.terrain !== data || this.tileLevel !== level || !this.slots || !this.tileTex) {
        bitmap.close(); // the level or the terrain changed while it loaded
        return;
      }
      const slot = this.slots.assign(name, this.tilesOnScreen);
      if (slot === null) {
        bitmap.close();
        return;
      }
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tileTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot, this.tilePx, this.tilePx, 1, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      bitmap.close();
      this.tileMapDirty = true;
      this.map?.triggerRepaint();
    }).catch(err => {
      this.tilesPending.delete(name);
      this.tilesFailedAt.set(name, performance.now());
      console.warn(`[${this.name}] terrain tile unavailable`, name, err);
    });
  }

  /** The tile map: which slot each tile sits in (see buildTileMap), uploaded when a slot changed. */
  private uploadTileMap(gl: WebGL2RenderingContext): void {
    const data = this.terrain;
    if (!data || !this.tileGrid || !this.slots) return;
    const map = buildTileMap(this.tileGrid, this.presentTiles(data), this.slots.resident());
    gl.bindTexture(gl.TEXTURE_2D, this.tileMapTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.tileGrid.cols, this.tileGrid.rows, 0, gl.RED, gl.UNSIGNED_BYTE, map);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tileMapDirty = false;
  }

  /** A 1 x 1 blank 2D-array texture: what the tile sampler reads when there is no terrain. */
  private blankTileArray(gl: WebGL2RenderingContext): WebGLTexture {
    if (!this.blankTiles) {
      this.blankTiles = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.blankTiles);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 1);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    return this.blankTiles;
  }
}
