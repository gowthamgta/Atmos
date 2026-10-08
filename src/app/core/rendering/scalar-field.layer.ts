import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { ForecastGrid, mercatorUnitX, mercatorUnitY } from '../forecast/forecast.model';
import { ForecastLayerDef, buildPaletteLut } from '../forecast/forecast-layers';
import {
  INSET_RAMP_DEG,
  DEWPOINT_LAPSE_C_PER_M,
  DIFFUSE_FRACTION,
  EXPOSURE_MAX,
  EXPOSURE_MIN,
  EXPOSURE_PER_M,
  LAPSE_RATE_C_PER_M,
  LOW_CLOUD_OROGRAPHIC_POWER,
  MAX_TERRAIN_DELTA_M,
  OROGRAPHIC_GAIN_S_PER_M,
  OROGRAPHIC_MAX,
  OROGRAPHIC_MIN,
  RH_LOG_PER_M,
  SEA_WIND_GAIN,
  SOLAR_FACTOR_MAX,
  TerrainMode,
  VAPOUR_SCALE_HEIGHT_M,
  WIND_FACTOR_MAX,
  WIND_FACTOR_MIN,
  solarDeclination,
} from '../forecast/terrain-correction';
import type { TerrainData } from '../forecast/terrain.service';

const VERTEX = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;
out vec2 v_merc;
void main() {
  v_merc = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const f = (n: number) => n.toFixed(8);

/** Shader code for each terrain mode (the numbers match TERRAIN_MODE_CODE). */
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
 * those bytes, so texels are fetched exactly, decoded, and interpolated here with a bicubic (Catmull-Rom) filter,
 * which gives smooth gradients without the diamond pattern of bilinear blending. Each pixel is then moved from the
 * model's ground to the real 1 km ground (see terrain-correction.ts, whose constants are inlined below), and the
 * 1 km relief can be shaded into the colours.
 *
 * Terrain images: metres = (R * 256 + G) / 65535 over u_demEnc, land fraction = B (no "no data" flag).
 */
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_a2;      // second component (vector layers), time A
uniform sampler2D u_b2;      // second component, time B
uniform sampler2D u_lut;
uniform sampler2D u_dem;       // 1 km terrain + land fraction
uniform sampler2D u_demModel;  // the ground as the model sees it (forecast grid) + its land fraction
uniform sampler2D u_demSmooth; // terrain smoothed over ~4 km
uniform sampler2D u_wuA;       // wind driving the orographic lift: u and v at times A and B
uniform sampler2D u_wuB;
uniform sampler2D u_wvA;
uniform sampler2D u_wvB;
uniform float u_mix;
uniform float u_opacity;
uniform vec2 u_enc;      // value range of the 16-bit encoding
uniform vec2 u_enc2;     // same, second component
uniform vec2 u_encWu;    // same, lift-wind u
uniform vec2 u_encWv;    // same, lift-wind v
uniform vec2 u_disp;     // display range mapped onto the palette
uniform float u_gamma;
uniform float u_clear;
uniform vec4 u_grid;     // lonMin, latMax, step, unused
uniform ivec2 u_size;
uniform vec4 u_demGrid;    // 1 km terrain: lonMin, latMax, step
uniform ivec2 u_demSize;
uniform vec4 u_smoothGrid; // smoothed terrain
uniform ivec2 u_smoothSize;
uniform vec4 u_modelGrid;  // model ground
uniform ivec2 u_modelSize;
uniform vec2 u_demEnc;     // terrain value range
uniform int u_terrainOn;   // 1 when the terrain textures are bound
uniform int u_magnitude;   // 1: show hypot(first, second component) e.g. wind speed from u and v
uniform int u_terrainMode; // 0 off, else TERRAIN_MODE_CODE
uniform int u_hasLift;     // 1 when the lift-wind textures are bound
uniform vec3 u_sun;        // declination (rad), equation of time (min), UTC minutes
uniform float u_relief;    // 0..1 strength of the relief shading
uniform float u_levelHeight; // pressure-level layers: height of the level (m); 0 at the ground
uniform int u_lite;        // 1: phone mode, about a fifth of the texture reads (bilinear fields, no slope-based corrections)
uniform sampler2D u_inset;  // Tamil Nadu 90 m terrain + land fraction (same encoding as u_dem)
uniform vec4 u_insetGrid;   // lonMin, latMax, step
uniform ivec2 u_insetSize;
uniform vec4 u_insetBounds; // lonMin, latMin, lonMax, latMax of the inset
uniform int u_insetOn;      // 1 when the inset is bound
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

vec4 catmullRom(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}

// Bicubic (Catmull-Rom) over the 4x4 texels around g, kept within the range of the 4 nearest so it never overshoots
// (no negative rain, no rings). Falls back to bilinear next to missing data. Returns (value, valid).
vec2 sampleCubic(sampler2D tex, vec2 g, ivec2 size, vec2 enc) {
  ivec2 i1 = ivec2(floor(g));
  vec2 fr = g - vec2(i1);
  vec4 wx = catmullRom(fr.x);
  vec4 wy = catmullRom(fr.y);
  float sum = 0.0;
  float lo = 1e30;
  float hi = -1e30;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      ivec2 p = clamp(i1 + ivec2(i - 1, j - 1), ivec2(0), size - 1);
      vec4 c = texelFetch(tex, p, 0);
      if (c.b > 0.5) return sampleField(tex, g, size, enc);
      float v = decode(c, enc);
      sum += v * wx[i] * wy[j];
      if ((i == 1 || i == 2) && (j == 1 || j == 2)) { lo = min(lo, v); hi = max(hi, v); }
    }
  }
  return vec2(clamp(sum, lo, hi), 1.0);
}

// Blends two time steps of one variable; where one step has no data the other is used. Returns (value, valid).
vec2 blendTime(sampler2D ta, sampler2D tb, vec2 g, vec2 enc) {
  vec2 a = u_lite == 1 ? sampleField(ta, g, u_size, enc) : sampleCubic(ta, g, u_size, enc);
  vec2 b = u_lite == 1 ? sampleField(tb, g, u_size, enc) : sampleCubic(tb, g, u_size, enc);
  float wa = (1.0 - u_mix) * (a.y > 0.5 ? 1.0 : 0.0);
  float wb = u_mix * (b.y > 0.5 ? 1.0 : 0.0);
  if (wa + wb < 0.0001) return vec2(0.0, 0.0);
  return vec2((a.x * wa + b.x * wb) / (wa + wb), 1.0);
}

float blendTimeLinear(sampler2D ta, sampler2D tb, vec2 g, vec2 enc) {
  vec2 a = sampleField(ta, g, u_size, enc);
  vec2 b = sampleField(tb, g, u_size, enc);
  float wa = (1.0 - u_mix) * (a.y > 0.5 ? 1.0 : 0.0);
  float wb = u_mix * (b.y > 0.5 ? 1.0 : 0.0);
  return wa + wb < 0.0001 ? 0.0 : (a.x * wa + b.x * wb) / (wa + wb);
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

// Weight of the 90 m inset: 0 at its edge (the 1 km terrain takes over, so the border is seamless), 1 once INSET_RAMP_DEG inside.
float insetWeight(float lat, float lon) {
  if (u_insetOn == 0) return 0.0;
  float d = min(min(lon - u_insetBounds.x, u_insetBounds.z - lon), min(lat - u_insetBounds.y, u_insetBounds.w - lat));
  return clamp(d / ${f(INSET_RAMP_DEG)}, 0.0, 1.0);
}

// Terrain (metres, land fraction) of the 1 km grid, faded into the 90 m inset where it covers the point.
vec2 fineAt(float lat, float lon) {
  vec2 coarse = terrainAt(u_dem, u_demGrid, u_demSize, lat, lon);
  float w = insetWeight(lat, lon);
  if (w <= 0.0) return coarse;
  return mix(coarse, terrainAt(u_inset, u_insetGrid, u_insetSize, lat, lon), w);
}

// Slope of the terrain used by fineAt: the inset's own grid where it covers the point, else the 1 km grid.
vec2 fineSlopeAt(float lat, float lon) {
  if (insetWeight(lat, lon) > 0.5) return slopeAt(u_inset, u_insetGrid, u_insetSize, lat, lon);
  return slopeAt(u_dem, u_demGrid, u_demSize, lat, lon);
}

vec3 sunVector(float lat, float lon) {
  float ha = radians((u_sun.z + u_sun.y + 4.0 * lon) / 4.0 - 180.0);
  float la = radians(lat);
  float d = u_sun.x;
  return vec3(-cos(d) * sin(ha), cos(la) * sin(d) - sin(la) * cos(d) * cos(ha), sin(la) * sin(d) + cos(la) * cos(d) * cos(ha));
}

void main() {
  float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * v_merc.y))));
  float lon = v_merc.x * 360.0 - 180.0;
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

  vec2 fine = vec2(0.0, 1.0);
  vec2 fineSlope = vec2(0.0);
  bool needFineSlope = u_lite == 0 && u_terrainOn == 1 && (u_relief > 0.0 || u_terrainMode == 8);
  if (u_terrainOn == 1) {
    fine = fineAt(lat, lon);
    if (needFineSlope) {
      fineSlope = fineSlopeAt(lat, lon);
    } else if (u_lite == 1 && u_relief > 0.0) {
      // the screen-space slope of the 1 km ground (one terrain read instead of sixteen), in metres per metre
      float mPerPx = max(length(dFdx(v_merc)) * 40075016.686 * cos(radians(lat)), 1.0);
      fineSlope = vec2(dFdx(fine.x), -dFdy(fine.x)) / mPerPx;
    }
  }

  if (u_terrainOn == 1 && u_terrainMode != 0) {
    vec2 model = terrainAt(u_demModel, u_modelGrid, u_modelSize, lat, lon);
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
    } else if ((m == 5 || m == 6) && u_hasLift == 1 && u_lite == 0) {
      vec2 wind = vec2(blendTimeLinear(u_wuA, u_wuB, g, u_encWu), blendTimeLinear(u_wvA, u_wvB, g, u_encWv));
      float liftFine = dot(wind, slopeAt(u_demSmooth, u_smoothGrid, u_smoothSize, lat, lon));
      float liftModel = dot(wind, slopeAt(u_demModel, u_modelGrid, u_modelSize, lat, lon));
      float k = clamp(1.0 + ${f(OROGRAPHIC_GAIN_S_PER_M)} * (liftFine - liftModel), ${f(OROGRAPHIC_MIN)}, ${f(OROGRAPHIC_MAX)});
      v = m == 5 ? v * k : min(100.0, v * pow(k, ${f(LOW_CLOUD_OROGRAPHIC_POWER)}));
    } else if (m == 8 && u_lite == 0) {
      vec3 sun = sunVector(lat, lon);
      if (sun.z > 0.05) {
        vec3 n = normalize(vec3(-fineSlope, 1.0));
        float direct = ${f(1 - DIFFUSE_FRACTION)} * max(dot(n, sun), 0.0) / max(sun.z, 0.1);
        float diffuse = ${f(DIFFUSE_FRACTION)} * (1.0 + n.z) * 0.5;
        v *= clamp(direct + diffuse, 0.0, ${f(SOLAR_FACTOR_MAX)});
      }
    }
  }

  float t = clamp((v - u_disp.x) / (u_disp.y - u_disp.x), 0.0, 1.0);
  t = pow(t, u_gamma);
  vec3 rgb = texture(u_lut, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb;
  float alpha = u_opacity * edgeFade;
  if (u_clear > 0.0) alpha *= smoothstep(u_clear, u_clear * 1.5, v);

  if (u_terrainOn == 1) {
    // 1 km relief: hills lit from the north-west, so the Ghats, Nilgiris and valleys read through every layer
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

/** Wind (u, v at the two time steps) that drives the orographic lift for rain and low cloud. */
export interface LiftWind {
  uA: FieldFrame;
  uB: FieldFrame;
  vA: FieldFrame;
  vB: FieldFrame;
  encU: [number, number];
  encV: [number, number];
}

interface Uniforms {
  [name: string]: WebGLUniformLocation | null;
}

const UNIFORMS = [
  'u_matrix', 'u_a', 'u_b', 'u_a2', 'u_b2', 'u_lut', 'u_dem', 'u_demModel', 'u_demSmooth', 'u_wuA', 'u_wuB', 'u_wvA', 'u_wvB',
  'u_mix', 'u_opacity', 'u_enc', 'u_enc2', 'u_encWu', 'u_encWv', 'u_disp', 'u_gamma', 'u_clear', 'u_grid', 'u_size',
  'u_demGrid', 'u_demSize', 'u_smoothGrid', 'u_smoothSize', 'u_modelGrid', 'u_modelSize', 'u_demEnc', 'u_terrainOn',
  'u_magnitude', 'u_terrainMode', 'u_hasLift', 'u_sun', 'u_relief', 'u_levelHeight', 'u_lite',
  'u_inset', 'u_insetGrid', 'u_insetSize', 'u_insetBounds', 'u_insetOn',
];

/** MapLibre custom layer drawing one forecast variable at 1 km, blended between two time steps on the GPU. */
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
  private liftWind: LiftWind | null = null;
  private mix = 0;
  private lutFor: ForecastLayerDef | null = null;
  private terrain: TerrainData | null = null;
  private modelBitmap: ImageBitmap | null = null;
  private demTex: WebGLTexture | null = null;
  private demModelTex: WebGLTexture | null = null;
  private demSmoothTex: WebGLTexture | null = null;
  private insetTex: WebGLTexture | null = null;
  private demUploaded = false;
  private insetUploaded = false;
  private modelUploaded: ImageBitmap | null = null;
  private sun: [number, number, number] = [0, 0, 0];
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
    if (this.terrain !== data) this.demUploaded = false;
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

  /** Wind for the orographic lift of rain and low cloud (null: no lift correction). */
  setLiftWind(wind: LiftWind | null): void {
    this.liftWind = wind;
    this.map?.triggerRepaint();
  }

  /** The shown time, for sunshine on slopes. */
  setTime(timeMs: number): void {
    const { declination, eqTimeMin } = solarDeclination(timeMs);
    const d = new Date(timeMs);
    this.sun = [declination, eqTimeMin, d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60];
    this.map?.triggerRepaint();
  }

  /**
   * Phone mode: bilinear fields and no slope-based corrections (rain/low cloud lift, sunshine on slopes), which cuts the
   * work per pixel to about a fifth. The height-based 1 km corrections and the relief shading stay.
   */
  setLite(lite: boolean): void {
    if (this.lite === lite) return;
    this.lite = lite;
    this.map?.triggerRepaint();
  }

  /** Strength (0..1) of the 1 km relief shading over land. */
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
    this.demTex = gl.createTexture();
    this.demModelTex = gl.createTexture();
    this.demSmoothTex = gl.createTexture();
    this.insetTex = gl.createTexture();
    this.demUploaded = false;
    this.insetUploaded = false;
    this.modelUploaded = null;
    this.uploadQuad();
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    for (const tex of this.textures.values()) gl.deleteTexture(tex);
    this.textures.clear();
    for (const tex of [this.lutTex, this.demTex, this.demModelTex, this.demSmoothTex, this.insetTex]) if (tex) gl.deleteTexture(tex);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.lutTex = this.demTex = this.demModelTex = this.demSmoothTex = this.insetTex = this.vbo = this.vao = this.program = null;
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
    if (this.terrain && !this.demUploaded) this.uploadTerrain(gl, this.terrain);
    if (this.modelBitmap && this.modelUploaded !== this.modelBitmap) {
      this.uploadTerrainImage(gl, this.demModelTex, this.modelBitmap);
      this.modelUploaded = this.modelBitmap;
    }
    const terrainOn = !!this.terrain && this.demUploaded && this.modelUploaded !== null;
    const insetOn = terrainOn && this.insetUploaded;
    const terrainMode = terrainOn && def.terrain ? TERRAIN_MODE_CODE[def.terrain] : 0;
    const lift = this.liftWind && !this.lite && (def.terrain === 'rain' || def.terrain === 'lowcloud') ? this.liftWind : null;

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
      bind(3, this.demTex);
      bind(4, this.demModelTex);
      bind(7, this.demSmoothTex);
    }
    if (insetOn) bind(12, this.insetTex);
    if (lift) {
      bind(8, this.textureFor(gl, lift.uA));
      bind(9, this.textureFor(gl, lift.uB));
      bind(10, this.textureFor(gl, lift.vA));
      bind(11, this.textureFor(gl, lift.vB));
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
    unit('u_dem', 3, terrainOn);
    unit('u_demModel', 4, terrainOn);
    unit('u_demSmooth', 7, terrainOn);
    unit('u_inset', 12, insetOn);
    unit('u_wuA', 8, !!lift);
    unit('u_wuB', 9, !!lift);
    unit('u_wvA', 10, !!lift);
    unit('u_wvB', 11, !!lift);
    gl.uniform1i(u['u_magnitude'], magnitude ? 1 : 0);
    gl.uniform1f(u['u_mix'], this.mix);
    gl.uniform1f(u['u_opacity'], def.opacity);
    gl.uniform2f(u['u_enc'], this.enc[0], this.enc[1]);
    gl.uniform2f(u['u_enc2'], this.enc2[0], this.enc2[1]);
    gl.uniform2f(u['u_encWu'], lift?.encU[0] ?? 0, lift?.encU[1] ?? 1);
    gl.uniform2f(u['u_encWv'], lift?.encV[0] ?? 0, lift?.encV[1] ?? 1);
    gl.uniform2f(u['u_disp'], def.min, def.max);
    gl.uniform1f(u['u_gamma'], def.gamma);
    gl.uniform1f(u['u_clear'], def.clearBelow);
    gl.uniform4f(u['u_grid'], grid.lonMin, grid.latMax, grid.step, 0);
    gl.uniform2i(u['u_size'], grid.nx, grid.ny);
    gl.uniform1i(u['u_terrainOn'], terrainOn ? 1 : 0);
    gl.uniform1i(u['u_terrainMode'], terrainMode);
    gl.uniform1i(u['u_hasLift'], lift ? 1 : 0);
    gl.uniform3f(u['u_sun'], this.sun[0], this.sun[1], this.sun[2]);
    gl.uniform1f(u['u_relief'], terrainOn ? this.relief : 0);
    gl.uniform1f(u['u_levelHeight'], def.levelHeightM ?? 0);
    gl.uniform1i(u['u_lite'], this.lite ? 1 : 0);
    const meta = this.terrain?.meta;
    if (terrainOn && meta) {
      const g4 = (name: string, g: ForecastGrid) => gl.uniform4f(u[name], g.lonMin, g.latMax, g.step, 0);
      const s2 = (name: string, g: ForecastGrid) => gl.uniform2i(u[name], g.nx, g.ny);
      g4('u_demGrid', meta.fine);
      s2('u_demSize', meta.fine);
      g4('u_smoothGrid', meta.smooth);
      s2('u_smoothSize', meta.smooth);
      g4('u_modelGrid', meta.model);
      s2('u_modelSize', meta.model);
      gl.uniform2f(u['u_demEnc'], meta.min, meta.max);
    } else {
      for (const name of ['u_demSize', 'u_smoothSize', 'u_modelSize']) gl.uniform2i(u[name], 1, 1);
    }
    gl.uniform1i(u['u_insetOn'], insetOn ? 1 : 0);
    const inset = this.terrain?.inset?.meta;
    if (insetOn && inset) {
      gl.uniform4f(u['u_insetGrid'], inset.lonMin, inset.latMax, inset.step, 0);
      gl.uniform2i(u['u_insetSize'], inset.nx, inset.ny);
      gl.uniform4f(u['u_insetBounds'], inset.lonMin, inset.latMin, inset.lonMax, inset.latMax);
    } else {
      gl.uniform2i(u['u_insetSize'], 1, 1);
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

  private uploadTerrain(gl: WebGL2RenderingContext, data: TerrainData): void {
    this.uploadTerrainImage(gl, this.demTex, data.fine);
    this.uploadTerrainImage(gl, this.demSmoothTex, data.smooth);
    if (data.inset) this.uploadTerrainImage(gl, this.insetTex, data.inset.bitmap);
    this.insetUploaded = !!data.inset;
    this.demUploaded = true;
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
    const inUse = [this.frameA, this.frameB, this.frameA2, this.frameB2, this.liftWind?.uA, this.liftWind?.uB, this.liftWind?.vA, this.liftWind?.vB];
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
