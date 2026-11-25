import type { Map as MapLibreMap } from 'maplibre-gl';
import { isPhone } from '../ui/device-profile';

const Z = 8;
const N_TILES = 1 << Z; // 256 x 256 global tiles (~611 m eq, ~489 m mid-lat)
const TILE_PX = 256;
const TERRARIUM_URL = (tx: number, ty: number) => `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${Z}/${tx}/${ty}.png`;
const RETRY_MS = 30_000;
const MIN_ZOOM = 4.2;

export const GLOBAL_TILE_ARRAY_UNIT = 13;
export const GLOBAL_TILE_MAP_UNIT = 14;

/** GLSL snippet for ~500 m global Terrarium z=8 terrain tiles outside South India. */
export const GLOBAL_TERRAIN_TILE_GLSL = `
uniform sampler2DArray u_gTiles;
uniform sampler2D u_gTileMap;
uniform int u_hasGlobalTiles;

float decodeTerrarium(vec4 c) {
  return max(0.0, (c.r * 65280.0 + c.g * 255.0 + c.b * 0.99609375) - 32768.0);
}

TerrainSample globalTileSample(vec2 vMerc, float lat) {
  if (u_hasGlobalTiles == 0) return TerrainSample(vec2(0.0), vec4(0.0), 0.0, vec2(0.0), 0.0);
  vec2 merc = vec2(fract(vMerc.x), clamp(vMerc.y, 0.0, 0.999999));
  vec2 tileF = merc * ${N_TILES}.0;
  ivec2 tid = ivec2(floor(tileF)) & (${N_TILES} - 1);
  int slot = int(texelFetch(u_gTileMap, tid, 0).r * 255.0 + 0.5);
  if (slot >= 254) return TerrainSample(vec2(0.0), vec4(0.0), 0.0, vec2(0.0), 0.0);

  vec2 px = clamp((tileF - vec2(tid)) * ${TILE_PX}.0 - 0.5, vec2(0.0), vec2(${TILE_PX - 1}.0));
  ivec2 i0 = ivec2(floor(px));
  vec2 f = px - vec2(i0);
  ivec2 hi = ivec2(${TILE_PX - 1});

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

  // Pixel spacing in metres at z=8 (~611 m eq / ~489 m mid-lat * cos(lat))
  float mPerPx = max(60.0, 611.5 * max(0.15, cos(radians(lat))));
  float gx = (e10 - eW) / (2.0 * mPerPx);
  float gy = (eN - e01) / (2.0 * mPerPx);
  return TerrainSample(vec2(elev, land), vec4(0.0), 0.0, vec2(gx, gy), 1.0);
}
`;

/** Streams visible AWS Open Data Terrarium z=7 (~1 km) PNG tiles into a WebGL2 texture array on demand. */
export class GlobalTerrainTileGpu {
  private map: MapLibreMap | null = null;
  private tileTex: WebGLTexture | null = null;
  private tileMapTex: WebGLTexture | null = null;
  private blankTiles: WebGLTexture | null = null;
  private readonly maxSlots = isPhone() ? 12 : 24;
  private readonly keyToSlot = new Map<string, number>();
  private readonly slotUsedAt = new Map<number, number>();
  private readonly pending = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private readonly tileMapData = new Uint8Array(N_TILES * N_TILES).fill(255);
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
    for (const tex of [this.tileMapTex, this.tileTex, this.blankTiles]) if (tex) gl.deleteTexture(tex);
    this.tileMapTex = this.tileTex = this.blankTiles = null;
    this.keyToSlot.clear();
    this.slotUsedAt.clear();
    this.pending.clear();
    this.failedAt.clear();
    this.tileMapData.fill(255);
    this.map = null;
  }

  get activeZoom(): boolean {
    return !!this.map && this.map.getZoom() >= MIN_ZOOM;
  }

  update(gl: WebGL2RenderingContext): void {
    if (!this.map || !this.tileTex || !this.tileMapTex || this.map.getZoom() < MIN_ZOOM) return;
    const b = this.map.getBounds();
    const sLat = Math.max(-85, b.getSouth());
    const nLat = Math.min(85, b.getNorth());
    const x0 = Math.floor(((b.getWest() + 180) / 360) * N_TILES);
    const x1 = Math.floor(((b.getEast() + 180) / 360) * N_TILES);
    const y0 = Math.max(0, Math.min(N_TILES - 1, this.latToTy(nLat)));
    const y1 = Math.max(0, Math.min(N_TILES - 1, this.latToTy(sLat)));
    const visible: Array<[number, number, string]> = [];
    const seen = new Set<string>();

    for (let ry = y0; ry <= y1; ry++) {
      for (let rx = x0; rx <= x1; rx++) {
        const tx = ((rx % N_TILES) + N_TILES) % N_TILES;
        const key = `${tx}_${ry}`;
        if (seen.has(key)) continue;
        seen.add(key);
        visible.push([tx, ry, key]);
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
      this.fetchTile(gl, tx, ty, key, seen);
    }

    if (this.mapDirty) {
      this.mapDirty = false;
      gl.bindTexture(gl.TEXTURE_2D, this.tileMapTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, N_TILES, N_TILES, 0, gl.RED, gl.UNSIGNED_BYTE, this.tileMapData);
    }
  }

  bind(gl: WebGL2RenderingContext, on: boolean): void {
    gl.activeTexture(gl.TEXTURE0 + GLOBAL_TILE_ARRAY_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, on && this.tileTex ? this.tileTex : this.blankArray(gl));
    if (on && this.tileMapTex) {
      gl.activeTexture(gl.TEXTURE0 + GLOBAL_TILE_MAP_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.tileMapTex);
    }
  }

  setUniforms(gl: WebGL2RenderingContext, u: Record<string, WebGLUniformLocation | null>, on: boolean): void {
    gl.uniform1i(u['u_gTiles'], GLOBAL_TILE_ARRAY_UNIT);
    gl.uniform1i(u['u_gTileMap'], on ? GLOBAL_TILE_MAP_UNIT : 0);
    gl.uniform1i(u['u_hasGlobalTiles'], on && this.activeZoom ? 1 : 0);
  }

  private latToTy(latDeg: number): number {
    const r = (latDeg * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N_TILES);
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
    const [vx, vy] = victimKey.split('_').map(Number);
    this.tileMapData[vy * N_TILES + vx] = 255;
    this.keyToSlot.delete(victimKey);
    this.keyToSlot.set(key, victimSlot);
    this.slotUsedAt.set(victimSlot, this.tick);
    return victimSlot;
  }

  private fetchTile(gl: WebGL2RenderingContext, tx: number, ty: number, key: string, visible: Set<string>): void {
    this.pending.add(key);
    fetch(TERRARIUM_URL(tx, ty))
      .then(r => {
        if (!r.ok) throw new Error(String(r.status));
        return r.blob();
      })
      .then(blob => createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
      .then(bitmap => {
        this.pending.delete(key);
        if (!this.tileTex) {
          bitmap.close();
          return;
        }
        const slot = this.assignSlot(key, visible);
        if (slot === null) {
          bitmap.close();
          return;
        }
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tileTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot, TILE_PX, TILE_PX, 1, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        bitmap.close();
        this.tileMapData[ty * N_TILES + tx] = slot;
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
      this.blankTiles = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.blankTiles);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    }
    return this.blankTiles;
  }
}
