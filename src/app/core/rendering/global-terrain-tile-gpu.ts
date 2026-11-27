import type { Map as MapLibreMap } from 'maplibre-gl';
import { isPhone } from '../ui/device-profile';

const TILE_PX = 256;
const RETRY_MS = 30_000;
const MIN_ZOOM = 2.5;

export const GLOBAL_TILE_ARRAY_UNIT = 14;
export const GLOBAL_TILE_MAP_UNIT = 15;

/** Selects the optimal elevation zoom level based on user map zoom (progressive up to 500 m max). */
export function getAdaptiveGlobalZ(mapZoom: number): number {
  if (mapZoom >= 6.5) return 8;   // ~500 m (highest resolution)
  if (mapZoom >= 4.5) return 6;   // ~2 km (fast medium-res)
  return 5;                       // ~4 km (instant low-res overview)
}

/** GLSL snippet for zoom-adaptive global Terrarium elevation tiles (500m -> 150m -> 75m -> 38m). */
export const GLOBAL_TERRAIN_TILE_GLSL = `
uniform sampler2DArray u_gTiles;
uniform sampler2D u_gTileMap;
uniform int u_hasGlobalTiles;
uniform float u_gTileCountGlobal;
uniform vec2 u_gTileOrigin;
uniform ivec2 u_gTileGrid;
uniform float u_gMPerPx;

float decodeTerrarium(vec4 c) {
  return max(0.0, (c.r * 65280.0 + c.g * 255.0 + c.b * 0.99609375) - 32768.0);
}

TerrainSample globalTileSample(vec2 vMerc, float lat) {
  if (u_hasGlobalTiles == 0) return TerrainSample(vec2(0.0), vec4(0.0), 0.0, vec2(0.0), 0.0);
  vec2 merc = vec2(fract(vMerc.x), clamp(vMerc.y, 0.0, 0.999999));
  vec2 tileF = merc * u_gTileCountGlobal;
  float dx = tileF.x - u_gTileOrigin.x;
  if (dx < 0.0) dx += u_gTileCountGlobal;
  if (dx >= u_gTileCountGlobal) dx -= u_gTileCountGlobal;
  float dy = tileF.y - u_gTileOrigin.y;
  ivec2 t = ivec2(int(floor(dx)), int(floor(dy)));
  if (t.x < 0 || t.y < 0 || t.x >= u_gTileGrid.x || t.y >= u_gTileGrid.y) {
    return TerrainSample(vec2(0.0), vec4(0.0), 0.0, vec2(0.0), 0.0);
  }
  int slot = int(texelFetch(u_gTileMap, t, 0).r * 255.0 + 0.5);
  if (slot >= 254) return TerrainSample(vec2(0.0), vec4(0.0), 0.0, vec2(0.0), 0.0);

  vec2 px = clamp((tileF - floor(tileF)) * 256.0 - 0.5, vec2(0.0), vec2(255.0));
  ivec2 i0 = ivec2(floor(px));
  vec2 f = px - vec2(i0);
  ivec2 hi = ivec2(255);

  float e00 = decodeTerrarium(texelFetch(u_gTiles, ivec3(clamp(i0, ivec2(0), hi), slot), 0));
  float e10 = decodeTerrarium(texelFetch(u_gTiles, ivec3(clamp(i0 + ivec2(1, 0), ivec2(0), hi), slot), 0));
  float e01 = decodeTerrarium(texelFetch(u_gTiles, ivec3(clamp(i0 + ivec2(0, 1), ivec2(0), hi), slot), 0));
  float e11 = decodeTerrarium(texelFetch(u_gTiles, ivec3(clamp(i0 + ivec2(1, 1), ivec2(0), hi), slot), 0));

  float eN = decodeTerrarium(texelFetch(u_gTiles, ivec3(clamp(i0 + ivec2(0, -1), ivec2(0), hi), slot), 0));
  float eW = decodeTerrarium(texelFetch(u_gTiles, ivec3(clamp(i0 + ivec2(-1, 0), ivec2(0), hi), slot), 0));

  float elev = mix(mix(e00, e10, f.x), mix(e01, e11, f.x), f.y);
  float l00 = e00 > 0.5 ? 1.0 : 0.0;
  float l10 = e10 > 0.5 ? 1.0 : 0.0;
  float l01 = e01 > 0.5 ? 1.0 : 0.0;
  float l11 = e11 > 0.5 ? 1.0 : 0.0;
  float land = mix(mix(l00, l10, f.x), mix(l01, l11, f.x), f.y);

  // Pixel spacing in metres at active zoom level
  float mPerPx = max(15.0, u_gMPerPx * max(0.15, cos(radians(lat))));
  float gx = (e10 - eW) / (2.0 * mPerPx);
  float gy = (eN - e01) / (2.0 * mPerPx);
  return TerrainSample(vec2(elev, land), vec4(0.0), 0.0, vec2(gx, gy), 1.0);
}
`;

/** Streams zoom-adaptive AWS Open Data Terrarium elevation tiles into a WebGL2 texture array on demand. */
export class GlobalTerrainTileGpu {
  private map: MapLibreMap | null = null;
  private tileTex: WebGLTexture | null = null;
  private tileMapTex: WebGLTexture | null = null;
  private blankTiles: WebGLTexture | null = null;
  private readonly maxSlots = isPhone() ? 18 : 36;
  private readonly keyToSlot = new Map<string, number>();
  private readonly slotUsedAt = new Map<number, number>();
  private readonly pending = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private currentZ = 8;
  private lastOriginX = -1;
  private lastOriginY = -1;
  private lastCols = 0;
  private lastRows = 0;
  private mapDirty = true;
  private tick = 0;

  attach(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.tileMapTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tileMapTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));

    this.tileTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tileTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, TILE_PX, TILE_PX, this.maxSlots);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.mapDirty = true;
  }

  detach(gl: WebGL2RenderingContext): void {
    for (const tex of [this.tileMapTex, this.tileTex, this.blankTiles, this.blankMapTex]) if (tex) gl.deleteTexture(tex);
    this.tileMapTex = this.tileTex = this.blankTiles = this.blankMapTex = null;
    this.keyToSlot.clear();
    this.slotUsedAt.clear();
    this.pending.clear();
    this.failedAt.clear();
    this.map = null;
  }

  get activeZoom(): boolean {
    return !!this.map && this.map.getZoom() >= MIN_ZOOM;
  }

  update(gl: WebGL2RenderingContext): void {
    if (!this.map || !this.tileTex || !this.tileMapTex || this.map.getZoom() < MIN_ZOOM) return;
    const zoom = this.map.getZoom();
    const targetZ = getAdaptiveGlobalZ(zoom);
    if (targetZ !== this.currentZ) {
      this.currentZ = targetZ;
      this.keyToSlot.clear();
      this.slotUsedAt.clear();
      this.pending.clear();
      this.failedAt.clear();
      this.mapDirty = true;
    }

    const nTiles = 1 << this.currentZ;
    const b = this.map.getBounds();
    const sLat = Math.max(-85, b.getSouth());
    const nLat = Math.min(85, b.getNorth());
    const x0 = Math.floor(((b.getWest() + 180) / 360) * nTiles);
    const x1 = Math.floor(((b.getEast() + 180) / 360) * nTiles);
    const y0 = Math.max(0, Math.min(nTiles - 1, this.latToTy(nLat, nTiles)));
    const y1 = Math.max(0, Math.min(nTiles - 1, this.latToTy(sLat, nTiles)));

    const rawCols = ((x1 - x0) % nTiles + nTiles) % nTiles + 1;
    const rawRows = y1 - y0 + 1;
    const cols = Math.min(nTiles, Math.max(1, Math.min(rawCols, 12)));
    const rows = Math.min(nTiles, Math.max(1, Math.min(rawRows, 10)));
    const originX = ((x0 % nTiles) + nTiles) % nTiles;
    const originY = y0;

    if (originX !== this.lastOriginX || originY !== this.lastOriginY || cols !== this.lastCols || rows !== this.lastRows) {
      this.lastOriginX = originX;
      this.lastOriginY = originY;
      this.lastCols = cols;
      this.lastRows = rows;
      this.mapDirty = true;
    }

    const visible: Array<[number, number, string]> = [];
    const seen = new Set<string>();

    for (let dy = 0; dy < rows; dy++) {
      for (let dx = 0; dx < cols; dx++) {
        const tx = (originX + dx) % nTiles;
        const ty = originY + dy;
        const key = `${this.currentZ}_${tx}_${ty}`;
        seen.add(key);
        visible.push([tx, ty, key]);
        if (visible.length >= this.maxSlots) break;
      }
      if (visible.length >= this.maxSlots) break;
    }

    this.tick++;
    for (const [, , key] of visible) {
      const slot = this.keyToSlot.get(key);
      if (slot !== undefined) this.slotUsedAt.set(slot, this.tick);
    }

    for (const [tx, ty, key] of visible) {
      if (this.keyToSlot.has(key) || this.pending.has(key)) continue;
      const ft = this.failedAt.get(key);
      if (ft !== undefined && performance.now() - ft < RETRY_MS) continue;
      this.fetchTile(gl, this.currentZ, tx, ty, key, seen);
    }

    if (this.mapDirty) {
      this.mapDirty = false;
      const tileMapData = new Uint8Array(cols * rows).fill(255);
      for (let dy = 0; dy < rows; dy++) {
        for (let dx = 0; dx < cols; dx++) {
          const tx = (originX + dx) % nTiles;
          const ty = originY + dy;
          const key = `${this.currentZ}_${tx}_${ty}`;
          const slot = this.keyToSlot.get(key);
          if (slot !== undefined) {
            tileMapData[dy * cols + dx] = slot;
          }
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, this.tileMapTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cols, rows, 0, gl.RED, gl.UNSIGNED_BYTE, tileMapData);
    }
  }

  bind(gl: WebGL2RenderingContext, on: boolean): void {
    gl.activeTexture(gl.TEXTURE0 + GLOBAL_TILE_ARRAY_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, on && this.tileTex ? this.tileTex : this.blankArray(gl));
    gl.activeTexture(gl.TEXTURE0 + GLOBAL_TILE_MAP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, on && this.tileMapTex ? this.tileMapTex : this.blankMap(gl));
  }

  setUniforms(gl: WebGL2RenderingContext, u: Record<string, WebGLUniformLocation | null>, on: boolean): void {
    const nTiles = 1 << this.currentZ;
    gl.uniform1i(u['u_gTiles'], GLOBAL_TILE_ARRAY_UNIT);
    gl.uniform1i(u['u_gTileMap'], GLOBAL_TILE_MAP_UNIT);
    gl.uniform1i(u['u_hasGlobalTiles'], on && this.activeZoom && this.keyToSlot.size > 0 ? 1 : 0);
    gl.uniform1f(u['u_gTileCountGlobal'], nTiles);
    gl.uniform2f(u['u_gTileOrigin'], this.lastOriginX, this.lastOriginY);
    gl.uniform2i(u['u_gTileGrid'], Math.max(1, this.lastCols), Math.max(1, this.lastRows));
    gl.uniform1f(u['u_gMPerPx'], 156543.03 / nTiles);
  }

  private latToTy(latDeg: number, nTiles: number): number {
    const r = (latDeg * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * nTiles);
  }

  private assignSlot(key: string, keep: Set<string>): number | null {
    const existing = this.keyToSlot.get(key);
    if (existing !== undefined) return existing;
    if (this.keyToSlot.size < this.maxSlots) {
      const slot = this.keyToSlot.size;
      this.keyToSlot.set(key, slot);
      this.slotUsedAt.set(slot, this.tick);
      return slot;
    }
    let victimKey: string | null = null;
    let victimSlot = -1;
    let oldest = Infinity;
    for (const [k, s] of this.keyToSlot) {
      if (keep.has(k)) continue;
      const used = this.slotUsedAt.get(s) ?? 0;
      if (used < oldest) {
        oldest = used;
        victimKey = k;
        victimSlot = s;
      }
    }
    if (victimKey === null || victimSlot < 0) return null;
    this.keyToSlot.delete(victimKey);
    this.keyToSlot.set(key, victimSlot);
    this.slotUsedAt.set(victimSlot, this.tick);
    return victimSlot;
  }

  private fetchTile(gl: WebGL2RenderingContext, z: number, tx: number, ty: number, key: string, visible: Set<string>): void {
    this.pending.add(key);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 6000) : null;
    fetch(`https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${tx}/${ty}.png`, {
      signal: controller?.signal,
    })
      .finally(() => {
        if (timer) clearTimeout(timer);
      })
      .then(r => {
        if (!r.ok) throw new Error(String(r.status));
        return r.blob();
      })
      .then(blob => createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
      .then(bitmap => {
        this.pending.delete(key);
        if (!this.tileTex || this.currentZ !== z) {
          bitmap.close();
          return;
        }
        const slot = this.assignSlot(key, visible);
        if (slot === null) {
          bitmap.close();
          return;
        }
        const prevActive = gl.getParameter(gl.ACTIVE_TEXTURE);
        gl.activeTexture(gl.TEXTURE0 + GLOBAL_TILE_ARRAY_UNIT);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tileTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot, TILE_PX, TILE_PX, 1, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        gl.activeTexture(prevActive);
        bitmap.close();
        this.mapDirty = true;
        this.map?.triggerRepaint();
      })
      .catch(() => {
        this.pending.delete(key);
        this.failedAt.set(key, performance.now());
      });
  }

  private blankArray(gl: WebGL2RenderingContext): WebGLTexture {
    if (!this.blankTiles) {
      this.blankTiles = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.blankTiles);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 1);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    return this.blankTiles;
  }

  private blankMapTex: WebGLTexture | null = null;
  private blankMap(gl: WebGL2RenderingContext): WebGLTexture {
    if (!this.blankMapTex) {
      this.blankMapTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.blankMapTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
    }
    return this.blankMapTex;
  }
}
