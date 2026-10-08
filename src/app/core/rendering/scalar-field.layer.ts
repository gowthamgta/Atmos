import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { ForecastGrid, mercatorUnitX, mercatorUnitY } from '../forecast/forecast.model';
import { ForecastLayerDef, buildPaletteLut } from '../forecast/forecast-layers';
import {
  DEWPOINT_LAPSE_C_PER_M,
  EXPOSURE_MAX,
  EXPOSURE_MIN,
  EXPOSURE_PER_M,
  LAPSE_RATE_C_PER_M,
  MAX_TERRAIN_DELTA_M,
  RH_LOG_PER_M,
  SEA_WIND_GAIN,
  TerrainMode,
  VAPOUR_SCALE_HEIGHT_M,
  WIND_FACTOR_MAX,
  WIND_FACTOR_MIN,
} from '../forecast/terrain-correction';
import type { TerrainData } from '../forecast/terrain.service';
import { TILE_SLOTS, TileGrid, TileSlots, buildTileMap, terrainLevelForZoom, tileGridOf, tilesInBounds, type TerrainLevel } from '../forecast/terrain-tiles';

const VERTEX = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;
out vec2 v_merc;
void main() {
  v_merc = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const f = (n: number) => n.toFixed(8);

/**
 * Shader code for each terrain mode. The shader applies 1 to 4 and 7 (the 90 m terrain corrections). Codes 5 (rain), 6
 * (low cloud) and 8 (sunshine) are kept for the point forecast only (see terrain-correction.ts): the shader ignores them.
 */
export const TERRAIN_MODE_CODE: Record<TerrainMode, number> = {
  temperature: 1,
  humidity: 2,
  dewpoint: 3,
  wind: 4,
  rain: 5,
  lowcloud: 6,
  column: 7,
  solar: 8,
};

/**
 * Fields are rg16 PNGs (R = high byte, G = low byte, B = 255 for "no data") on the 0.1° grid. The GPU cannot filter
 * those bytes, so texels are fetched exactly, decoded, and interpolated here, bilinearly. Each pixel is then moved from
 * the model's ground to the real terrain (see terrain-correction.ts, whose constants are inlined below), and the terrain
 * relief can be shaded into the colours.
 *
 * Terrain images: metres = (R * 256 + G) / 65535 over u_demEnc, land fraction = B (no "no data" flag).
 */
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision lowp sampler2DArray;   // the terrain tiles (GLSL ES 3.00 wants a precision for every sampler type)
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_a2;      // second component (vector layers), time A
uniform sampler2D u_b2;      // second component, time B
uniform sampler2D u_lut;
uniform sampler2D u_demModel;  // the ground as the model sees it (forecast grid) + its land fraction
uniform sampler2D u_demSmooth; // terrain smoothed over ~4 km
uniform float u_mix;
uniform float u_opacity;
uniform vec2 u_enc;      // value range of the 16-bit encoding
uniform vec2 u_enc2;     // same, second component
uniform vec2 u_disp;     // display range mapped onto the palette
uniform float u_gamma;
uniform float u_clear;
uniform vec4 u_grid;     // lonMin, latMax, step, unused
uniform ivec2 u_size;
uniform sampler2DArray u_tiles; // the 90 m terrain tiles held on the GPU at the detail level in use, one per layer
uniform sampler2D u_tileMap;    // which layer holds each 1 x 1 degree tile (see terrain-tiles.ts)
uniform ivec2 u_tileCount;      // tile columns and rows of the domain
uniform vec2 u_tileOrigin;      // lonMin of tile column 0, and the top (north) edge of tile row 0
uniform float u_tilePx;         // cells per degree at the detail level in use
uniform vec4 u_smoothGrid; // smoothed terrain
uniform ivec2 u_smoothSize;
uniform vec4 u_modelGrid;  // model ground
uniform ivec2 u_modelSize;
uniform vec2 u_demEnc;     // terrain value range
uniform int u_terrainOn;   // 1 when the terrain textures are bound
uniform vec4 u_terrainBox; // west, south, east, north: where the 90 m terrain is; outside it the model's own ground is used
uniform int u_magnitude;   // 1: show hypot(first, second component) e.g. wind speed from u and v
uniform int u_terrainMode; // 0 off, else TERRAIN_MODE_CODE
uniform float u_relief;    // 0..1 strength of the relief shading
uniform float u_levelHeight; // pressure-level layers: height of the level (m); 0 at the ground
uniform int u_lite;        // 1: phone mode, the relief slope from screen differences (about 20 texture reads per pixel fewer)
in vec2 v_merc;
out vec4 outColor;

const float PI = 3.14159265358979;
const float M_PER_DEG = 111200.0;

float decode(vec4 c, vec2 enc) {
  float q = floor(c.r * 255.0 + 0.5) * 256.0 + floor(c.g * 255.0 + 0.5);
  return enc.x + q / 65535.0 * (enc.y - enc.x);
}

// Bilinear. Returns (value, weight of valid neighbours).
vec2 sampleField(sampler2D tex, vec2 g, ivec2 size, vec2 enc) {
  vec2 fr = fract(g);
  ivec2 i0 = ivec2(floor(g));
  float sum = 0.0;
  float wsum = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    ivec2 p = clamp(i0 + o, ivec2(0), size - 1);
    float w = (o.x == 1 ? fr.x : 1.0 - fr.x) * (o.y == 1 ? fr.y : 1.0 - fr.y);
    vec4 c = texelFetch(tex, p, 0);
    if (c.b > 0.5) continue;
    sum += decode(c, enc) * w;
    wsum += w;
  }
  return vec2(wsum > 0.001 ? sum / wsum : 0.0, wsum);
}

// Blends two time steps of one variable; where one step has no data the other is used. Returns (value, valid).
vec2 blendTime(sampler2D ta, sampler2D tb, vec2 g, vec2 enc) {
  vec2 a = sampleField(ta, g, u_size, enc);
  vec2 b = sampleField(tb, g, u_size, enc);
  float wa = (1.0 - u_mix) * (a.y > 0.5 ? 1.0 : 0.0);
  float wb = u_mix * (b.y > 0.5 ? 1.0 : 0.0);
  if (wa + wb < 0.0001) return vec2(0.0, 0.0);
  return vec2((a.x * wa + b.x * wb) / (wa + wb), 1.0);
}

// Terrain: (metres, land fraction), bilinear.
vec2 terrainAt(sampler2D tex, vec4 grid, ivec2 size, float lat, float lon) {
  vec2 g = clamp(vec2((lon - grid.x) / grid.z, (grid.y - lat) / grid.z), vec2(0.0), vec2(size) - 1.0001);
  vec2 fr = fract(g);
  ivec2 i0 = ivec2(floor(g));
  vec2 acc = vec2(0.0);
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    vec4 c = texelFetch(tex, clamp(i0 + o, ivec2(0), size - 1), 0);
    float w = (o.x == 1 ? fr.x : 1.0 - fr.x) * (o.y == 1 ? fr.y : 1.0 - fr.y);
    acc += vec2(decode(c, u_demEnc), c.b) * w;
  }
  return acc;
}

// Slope (m/m, rising east and north) of a terrain image, central differences one grid step apart.
vec2 slopeAt(sampler2D tex, vec4 grid, ivec2 size, float lat, float lon) {
  float s = grid.z;
  float zE = terrainAt(tex, grid, size, lat, lon + s).x;
  float zW = terrainAt(tex, grid, size, lat, lon - s).x;
  float zN = terrainAt(tex, grid, size, lat + s, lon).x;
  float zS = terrainAt(tex, grid, size, lat - s, lon).x;
  return vec2((zE - zW) / (2.0 * s * M_PER_DEG * cos(radians(lat))), (zN - zS) / (2.0 * s * M_PER_DEG));
}

// The ground from the 90 m tiles held on the GPU: (metres, land fraction, 1). Open sea is 0 m with no land and counts as
// held. A tile that is not on the GPU, or lies outside the domain, gives (0, 0, 0): the caller then uses the model's ground.
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

void main() {
  float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * v_merc.y))));
  float lon = v_merc.x * 360.0 - 180.0;
  bool onGround = u_terrainOn == 1 && lon >= u_terrainBox.x && lon <= u_terrainBox.z && lat >= u_terrainBox.y && lat <= u_terrainBox.w;
  vec2 g = vec2((lon - u_grid.x) / u_grid.z, (u_grid.y - lat) / u_grid.z);
  // Fade out over the last 12 cells (about 1.2 degrees) so the data area does not end in a hard edge.
  vec2 toFar = vec2(u_size) - 1.0 - g;
  float edge = min(min(g.x, g.y), min(toFar.x, toFar.y));
  float edgeFade = smoothstep(0.0, 12.0, edge);
  g = clamp(g, vec2(0.0), vec2(u_size) - 1.0001);

  vec2 first = blendTime(u_a, u_b, g, u_enc);
  if (first.y < 0.5) discard;              // no data at either time
  float v = first.x;
  if (u_magnitude == 1) {
    vec2 second = blendTime(u_a2, u_b2, g, u_enc2);
    if (second.y < 0.5) discard;
    v = length(vec2(first.x, second.x));
  }

  // the ground under the pixel: its 90 m tile where that is on the GPU, else the model's own ground (nothing corrected there)
  vec2 model = vec2(0.0, 1.0);
  vec2 fine = vec2(0.0, 1.0);
  vec2 fineSlope = vec2(0.0);
  bool needFineSlope = u_lite == 0 && onGround && u_relief > 0.0;
  if (onGround) {
    model = terrainAt(u_demModel, u_modelGrid, u_modelSize, lat, lon);
    vec3 tile = tileTerrain(lat, lon);
    fine = tile.z > 0.5 ? tile.xy : model;
    if (needFineSlope) {
      fineSlope = tile.z > 0.5 ? tileSlope(lat, lon) : vec2(0.0);
    } else if (u_lite == 1 && u_relief > 0.0) {
      // the screen-space slope of the ground (one terrain read instead of sixteen), in metres per metre
      float mPerPx = max(length(dFdx(v_merc)) * 40075016.686 * cos(radians(lat)), 1.0);
      fineSlope = vec2(dFdx(fine.x), -dFdy(fine.x)) / mPerPx;
    }
  }

  if (onGround && u_terrainMode != 0) {
    float dz = clamp(fine.x - model.x, -${f(MAX_TERRAIN_DELTA_M)}, ${f(MAX_TERRAIN_DELTA_M)});
    int m = u_terrainMode;
    if (m == 1) {
      v -= ${f(LAPSE_RATE_C_PER_M)} * dz;
    } else if (m == 2) {
      v = min(100.0, v * exp(${f(RH_LOG_PER_M)} * dz));
    } else if (m == 3) {
      v -= ${f(DEWPOINT_LAPSE_C_PER_M)} * dz;
    } else if (m == 7) {
      v *= exp(-dz / ${f(VAPOUR_SCALE_HEIGHT_M)});
    } else if (m == 4) {
      float tpi = fine.x - terrainAt(u_demSmooth, u_smoothGrid, u_smoothSize, lat, lon).x;
      float exposure = clamp(1.0 + tpi * ${f(EXPOSURE_PER_M)}, ${f(EXPOSURE_MIN)}, ${f(EXPOSURE_MAX)});
      float coast = 1.0 + ${f(SEA_WIND_GAIN)} * (model.y - fine.y);
      v *= clamp(exposure * coast, ${f(WIND_FACTOR_MIN)}, ${f(WIND_FACTOR_MAX)});
    }
  }

  float t = clamp((v - u_disp.x) / (u_disp.y - u_disp.x), 0.0, 1.0);
  t = pow(t, u_gamma);
  vec3 rgb = texture(u_lut, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb;
  float alpha = u_opacity * edgeFade;
  if (u_clear > 0.0) alpha *= smoothstep(u_clear, u_clear * 1.5, v);

  if (onGround) {
    // 90 m relief: hills lit from the north-west, so the Ghats, Nilgiris and valleys read through every layer
    if (u_relief > 0.0) {
      vec3 n = normalize(vec3(-fineSlope * 3.0, 1.0));
      vec3 light = normalize(vec3(-0.55, 0.55, 0.63));
      float shade = dot(n, light) / light.z;
      rgb *= mix(1.0, clamp(1.0 + u_relief * (shade - 1.0), 0.55, 1.4), fine.y);
    }
    // pressure levels: where the ground stands above the level there is no air at that height
    if (u_levelHeight > 0.0) {
      float under = smoothstep(u_levelHeight - 150.0, u_levelHeight + 150.0, fine.x);
      float grey = dot(rgb, vec3(0.299, 0.587, 0.114));
      rgb = mix(rgb, vec3(grey * 0.6), under * 0.8);
      alpha *= 1.0 - 0.55 * under;
    }
  }
  outColor = vec4(rgb * alpha, alpha);   // premultiplied for MapLibre's blend function
}`;

export interface FieldFrame {
  /** Unique key of the image (run/var/step) so textures can be reused. */
  key: string;
  bitmap: ImageBitmap;
}

interface Uniforms {
  [name: string]: WebGLUniformLocation | null;
}

const UNIFORMS = [
  'u_matrix', 'u_a', 'u_b', 'u_a2', 'u_b2', 'u_lut', 'u_demModel', 'u_demSmooth',
  'u_mix', 'u_opacity', 'u_enc', 'u_enc2', 'u_disp', 'u_gamma', 'u_clear', 'u_grid', 'u_size',
  'u_smoothGrid', 'u_smoothSize', 'u_modelGrid', 'u_modelSize', 'u_demEnc', 'u_terrainOn', 'u_terrainBox',
  'u_magnitude', 'u_terrainMode', 'u_relief', 'u_levelHeight', 'u_lite',
  'u_tiles', 'u_tileMap', 'u_tileCount', 'u_tileOrigin', 'u_tilePx',
];

/** MapLibre custom layer drawing one forecast variable on the 90 m terrain, blended between two time steps on the GPU. */
export class ScalarFieldLayer implements CustomLayerInterface {
  readonly id = 'forecast-scalar-layer';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private lutTex: WebGLTexture | null = null;
  private uniforms: Uniforms = {};
  private readonly textures = new Map<string, WebGLTexture>(); // insertion order = LRU order
  private static readonly MAX_TEXTURES = 16;

  private grid: ForecastGrid | null = null;
  private def: ForecastLayerDef | null = null;
  private enc: [number, number] = [0, 1];
  private enc2: [number, number] = [0, 1];
  private frameA: FieldFrame | null = null;
  private frameB: FieldFrame | null = null;
  private frameA2: FieldFrame | null = null;
  private frameB2: FieldFrame | null = null;
  private mix = 0;
  private lutFor: ForecastLayerDef | null = null;
  private terrain: TerrainData | null = null;
  private modelBitmap: ImageBitmap | null = null;
  private demModelTex: WebGLTexture | null = null;
  private demSmoothTex: WebGLTexture | null = null;
  private smoothUploadedFor: TerrainData | null = null;
  private modelUploaded: ImageBitmap | null = null;
  /** The 90 m tiles of the detail level in use, one per layer of a texture array (see updateTiles). */
  private tileTex: WebGLTexture | null = null;
  /** Which layer holds each 1 x 1 degree tile of the domain (one byte each; see buildTileMap). */
  private tileMapTex: WebGLTexture | null = null;
  private tileGrid: TileGrid | null = null;
  private tileLevel: TerrainLevel | null = null;
  private tilePx = 1;
  private slots: TileSlots | null = null;
  private tilesPending = new Set<string>();
  private tilesOnScreen = new Set<string>();
  private tileMapDirty = true;
  private presentCache: ReadonlySet<string> | null = null;
  private presentCacheFor: TerrainData | null = null;
  private presentCacheLevel: number | null = null;
  private relief = 0;
  private lite = false;
  private visible = false;

  /** Static grid geometry; call before the first frame. */
  setGrid(grid: ForecastGrid): void {
    if (this.grid === grid) return;
    this.grid = grid;
    this.uploadQuad();
  }

  /** Show a variable (or hide with null). `enc` / `enc2` are the manifest's encoding ranges of its one or two variables. */
  setLayer(def: ForecastLayerDef | null, enc?: [number, number], enc2?: [number, number]): void {
    this.def = def;
    if (enc) this.enc = enc;
    this.enc2 = enc2 ?? this.enc;
    this.visible = def !== null;
    this.map?.triggerRepaint();
  }

  /** Provide (or clear) the terrain, and the model ground matching the shown model's resolution. */
  setTerrain(data: TerrainData | null, modelBitmap: ImageBitmap | null): void {
    if (this.terrain === data && this.modelBitmap === modelBitmap) return;
    if (this.terrain !== data) this.resetTiles();
    this.terrain = data;
    this.modelBitmap = modelBitmap;
    this.map?.triggerRepaint();
  }

  /** Two time steps of the variable, plus the same two steps of a second component for vector layers. */
  setFrames(a: FieldFrame, b: FieldFrame, mix: number, a2: FieldFrame | null = null, b2: FieldFrame | null = null): void {
    this.frameA = a;
    this.frameB = b;
    this.frameA2 = a2;
    this.frameB2 = b2;
    this.mix = mix;
    this.map?.triggerRepaint();
  }

  /**
   * Phone mode: the relief slope comes from screen-space differences of the terrain, not four extra terrain reads per
   * pixel, which keeps the frame rate on small screens. The height-based terrain corrections stay on both.
   */
  setLite(lite: boolean): void {
    if (this.lite === lite) return;
    this.lite = lite;
    this.map?.triggerRepaint();
  }

  /** Strength (0..1) of the 90 m relief shading over land. */
  setRelief(strength: number): void {
    if (this.relief === strength) return;
    this.relief = strength;
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    const program = this.link(gl, VERTEX, FRAGMENT);
    this.program = program;
    this.uniforms = {};
    for (const name of UNIFORMS) this.uniforms[name] = gl.getUniformLocation(program, name);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.lutTex = gl.createTexture();
    this.demModelTex = gl.createTexture();
    this.demSmoothTex = gl.createTexture();
    this.tileMapTex = gl.createTexture();
    this.smoothUploadedFor = null;
    this.modelUploaded = null;
    this.uploadQuad();
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    for (const tex of this.textures.values()) gl.deleteTexture(tex);
    this.textures.clear();
    for (const tex of [this.lutTex, this.demModelTex, this.demSmoothTex, this.tileMapTex, this.tileTex]) if (tex) gl.deleteTexture(tex);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.lutTex = this.demModelTex = this.demSmoothTex = this.tileMapTex = this.tileTex = this.vbo = this.vao = this.program = null;
    this.slots = null;
    this.tileLevel = null;
    this.map = null;
    this.gl = null;
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const { grid, def, frameA, frameB, program } = this;
    if (!this.visible || !grid || !def || !frameA || !frameB || !program) return;

    const texA = this.textureFor(gl, frameA);
    const texB = frameB.key === frameA.key ? texA : this.textureFor(gl, frameB);
    const magnitude = def.varId2 !== undefined && this.frameA2 !== null && this.frameB2 !== null;
    if (def.varId2 !== undefined && !magnitude) return; // second component not loaded yet
    const texA2 = magnitude ? this.textureFor(gl, this.frameA2!) : null;
    const texB2 = magnitude ? (this.frameB2!.key === this.frameA2!.key ? texA2 : this.textureFor(gl, this.frameB2!)) : null;
    if (this.lutFor !== def) this.uploadLut(gl, def);
    if (this.terrain && this.smoothUploadedFor !== this.terrain) {
      this.uploadTerrainImage(gl, this.demSmoothTex, this.terrain.smooth);
      this.smoothUploadedFor = this.terrain;
    }
    if (this.modelBitmap && this.modelUploaded !== this.modelBitmap) {
      this.uploadTerrainImage(gl, this.demModelTex, this.modelBitmap);
      this.modelUploaded = this.modelBitmap;
    }
    if (this.terrain) this.updateTiles(gl, this.terrain);
    const terrainOn = !!this.terrain && this.smoothUploadedFor === this.terrain && this.modelUploaded !== null && this.tileTex !== null;
    const terrainMode = terrainOn && def.terrain ? TERRAIN_MODE_CODE[def.terrain] : 0;

    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    const bind = (unit: number, tex: WebGLTexture | null) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    };
    bind(0, texA);
    bind(1, texB);
    bind(2, this.lutTex);
    if (magnitude) {
      bind(5, texA2);
      bind(6, texB2);
    }
    if (terrainOn) {
      bind(4, this.demModelTex);
      bind(7, this.demSmoothTex);
      gl.activeTexture(gl.TEXTURE0 + 12);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tileTex);
      bind(13, this.tileMapTex);
    }

    const u = this.uniforms;
    // Unused samplers must not alias a unit holding a different kind of texture; point them at unit 0.
    const unit = (name: string, n: number, used: boolean) => gl.uniform1i(u[name], used ? n : 0);
    gl.uniformMatrix4fv(u['u_matrix'], false, options.defaultProjectionData.mainMatrix as unknown as Float32List);
    unit('u_a', 0, true);
    unit('u_b', 1, true);
    unit('u_lut', 2, true);
    unit('u_a2', 5, magnitude);
    unit('u_b2', 6, magnitude);
    unit('u_demModel', 4, terrainOn);
    unit('u_demSmooth', 7, terrainOn);
    unit('u_tiles', 12, terrainOn);
    unit('u_tileMap', 13, terrainOn);
    gl.uniform1i(u['u_magnitude'], magnitude ? 1 : 0);
    gl.uniform1f(u['u_mix'], this.mix);
    gl.uniform1f(u['u_opacity'], def.opacity);
    gl.uniform2f(u['u_enc'], this.enc[0], this.enc[1]);
    gl.uniform2f(u['u_enc2'], this.enc2[0], this.enc2[1]);
    gl.uniform2f(u['u_disp'], def.min, def.max);
    gl.uniform1f(u['u_gamma'], def.gamma);
    gl.uniform1f(u['u_clear'], def.clearBelow);
    gl.uniform4f(u['u_grid'], grid.lonMin, grid.latMax, grid.step, 0);
    gl.uniform2i(u['u_size'], grid.nx, grid.ny);
    gl.uniform1i(u['u_terrainOn'], terrainOn ? 1 : 0);
    gl.uniform1i(u['u_terrainMode'], terrainMode);
    gl.uniform1f(u['u_relief'], terrainOn ? this.relief : 0);
    gl.uniform1f(u['u_levelHeight'], def.levelHeightM ?? 0);
    gl.uniform1i(u['u_lite'], this.lite ? 1 : 0);
    const meta = this.terrain?.meta;
    if (terrainOn && meta && this.tileGrid) {
      const g4 = (name: string, g: ForecastGrid) => gl.uniform4f(u[name], g.lonMin, g.latMax, g.step, 0);
      const s2 = (name: string, g: ForecastGrid) => gl.uniform2i(u[name], g.nx, g.ny);
      g4('u_smoothGrid', meta.smooth);
      s2('u_smoothSize', meta.smooth);
      g4('u_modelGrid', meta.grid);
      s2('u_modelSize', meta.grid);
      gl.uniform2f(u['u_demEnc'], meta.min, meta.max);
      gl.uniform4f(u['u_terrainBox'], meta.domain.lonMin, meta.domain.latMin, meta.domain.lonMax, meta.domain.latMax);
      gl.uniform2i(u['u_tileCount'], this.tileGrid.cols, this.tileGrid.rows);
      gl.uniform2f(u['u_tileOrigin'], this.tileGrid.lonMin, this.tileGrid.latTop);
      gl.uniform1f(u['u_tilePx'], this.tilePx);
    } else {
      for (const name of ['u_smoothSize', 'u_modelSize']) gl.uniform2i(u[name], 1, 1);
      gl.uniform2i(u['u_tileCount'], 0, 0);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  // ── GL helpers ──────────────────────────────────────────────────────────

  private uploadQuad(): void {
    const { gl, grid } = this;
    if (!gl || !grid || !this.program || !this.vao || !this.vbo) return;
    const x0 = mercatorUnitX(grid.lonMin);
    const x1 = mercatorUnitX(grid.lonMax);
    const y0 = mercatorUnitY(grid.latMax);
    const y1 = mercatorUnitY(grid.latMin);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x0, y0, x1, y0, x0, y1, x1, y1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program!, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private uploadLut(gl: WebGL2RenderingContext, def: ForecastLayerDef): void {
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildPaletteLut(def.stops));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.lutFor = def;
  }

  private uploadTerrainImage(gl: WebGL2RenderingContext, tex: WebGLTexture | null, bitmap: ImageBitmap): void {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Drops the tiles on the GPU (new terrain): the next frame loads them again. */
  private resetTiles(): void {
    if (this.gl && this.tileTex) this.gl.deleteTexture(this.tileTex);
    this.tileTex = null;
    this.tileLevel = null;
    this.slots = null;
    this.tilesPending.clear();
    this.tileMapDirty = true;
  }

  /**
   * Keeps the 90 m tiles on screen on the GPU: the detail level follows the zoom (see terrainLevelForZoom), each tile on
   * screen that is not held yet is loaded into a free slot, and the tile map is refreshed when a slot changes. A tile
   * that finds no slot (every slot holds a tile on screen) is not drawn: its pixels use the model's ground.
   */
  private updateTiles(gl: WebGL2RenderingContext, data: TerrainData): void {
    if (!this.map) return;
    const level = terrainLevelForZoom(this.map.getZoom());
    if (level !== this.tileLevel || !this.tileTex) this.switchTileLevel(gl, data, level);
    if (!this.slots || !this.tileGrid) return;
    const b = this.map.getBounds();
    const bounds = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
    const visible = tilesInBounds(this.tileGrid, bounds, this.presentTiles(data));
    this.tilesOnScreen = new Set(visible);
    this.slots.touch(visible);
    for (const name of visible) {
      if (this.slots.has(name) || this.tilesPending.has(name)) continue;
      this.loadTile(gl, data, name, level);
    }
    if (this.tileMapDirty) this.uploadTileMap(gl);
  }

  /** The tiles that have ground (a tile not in the list is open sea), read once per terrain. */
  private presentTiles(data: TerrainData): ReadonlySet<string> {
    const level = this.tileLevel;
    if (this.presentCacheFor !== data || this.presentCacheLevel !== level) {
      // the 90 m level only has tiles where there is a 90 m file (South India); the others use the 270 m tiles
      this.presentCache = new Set(level === 0 ? data.meta.tilesL0 ?? data.meta.tiles : data.meta.tiles);
      this.presentCacheFor = data;
      this.presentCacheLevel = level;
    }
    return this.presentCache!;
  }

  /** A new detail level: a texture array with a slot per tile the level can hold on screen. */
  private switchTileLevel(gl: WebGL2RenderingContext, data: TerrainData, level: TerrainLevel): void {
    if (this.tileTex) gl.deleteTexture(this.tileTex);
    this.tilesPending.clear();
    this.tileLevel = level;
    this.tileGrid = tileGridOf(data.meta.domain);
    this.tilePx = data.meta.levels.find(l => l.id === level)?.perDeg ?? 1200;
    const slots = TILE_SLOTS[level];
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

  /** Loads one tile and puts it in a free slot (if none is free, it is left out: see updateTiles). */
  private loadTile(gl: WebGL2RenderingContext, data: TerrainData, name: string, level: TerrainLevel): void {
    this.tilesPending.add(name);
    data.tileImage(level, name).then(bitmap => {
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
      console.warn('[forecast] terrain tile unavailable', name, err);
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

  private textureFor(gl: WebGL2RenderingContext, frame: FieldFrame): WebGLTexture {
    const cached = this.textures.get(frame.key);
    if (cached) {
      this.textures.delete(frame.key);
      this.textures.set(frame.key, cached); // mark most recently used
      return cached;
    }
    const tex = gl.createTexture()!;
    // NEAREST is required: the shader decodes exact bytes and interpolates the decoded values itself.
    this.uploadTerrainImage(gl, tex, frame.bitmap);
    this.textures.set(frame.key, tex);
    const inUse = [this.frameA, this.frameB, this.frameA2, this.frameB2];
    while (this.textures.size > ScalarFieldLayer.MAX_TEXTURES) {
      const oldest = this.textures.keys().next().value as string;
      if (inUse.some(f => f?.key === oldest)) break;
      gl.deleteTexture(this.textures.get(oldest)!);
      this.textures.delete(oldest);
    }
    return tex;
  }

  private link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
    const compile = (type: number, src: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`forecast shader: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`forecast program: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
  }
}
