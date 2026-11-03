import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { mercatorUnitX, mercatorUnitY } from '../forecast/forecast.model';
import type { GeoBounds } from '../satellite/satellite.config';
import type { CustomChannel } from '../satellite/own-products';
import { windyInfraredTable } from '../satellite/satellite-image';
import { PendingProgram } from './gl-program';

/**
 * Our own satellite products drawn in the browser from a frame's data pack (pipeline/himawari_rgb.py): a lossless PNG of brightness
 * temperatures, red 10.4 um, green 6.2 um, blue 7.3 um, kelvin = minK + value / 255 x spanK (0 = no data), Mercator rows over its bounds.
 * The colours are worked out per pixel here, so switching between modes or changing the custom recipe needs nothing new from the network:
 *
 * 0  Infrared: the cloud-top temperature in Windy's infrared colours (satellite-image.ts windyInfraredTable: the colours the agreed infrared
 *    picture was matched to Windy with, for the measured temperature), read from a table texture
 * 1  WV difference: 6.2 minus 7.3 um. Large negative = a dry upper troposphere (brown, orange); near zero = moist upper air or thick cloud
 *    (white, blue); positive = moisture above the 7.3 um level, overshooting tops (violet)
 * 2  Custom RGB: each colour from a band or a difference, with the WMO formula ((v - min) / (max - min)) ^ (1 / gamma)
 *
 * The temperatures are read with a bilinear filter of the decoded kelvin that leaves out empty texels, so no false cold edge appears where
 * the data ends. Two frames fade into each other while the loop plays.
 */
const VERTEX = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;
out vec2 v_merc;
void main() {
  v_merc = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform vec4 u_box;
uniform ivec2 u_size;
uniform float u_mixB;
uniform int u_hasB;
uniform float u_opacity;
uniform int u_mode;
uniform float u_minK;
uniform float u_spanK;
uniform ivec3 u_src;
uniform vec2 u_rangeR;
uniform vec2 u_rangeG;
uniform vec2 u_rangeB;
uniform vec3 u_gamma;
uniform sampler2D u_lut;   // Windy's infrared colours over minK .. minK + spanK (RGBA, alpha included)
in vec2 v_merc;
out vec4 o;

// the three temperatures (kelvin) at a texel, and whether it has data
vec4 texK(sampler2D t, ivec2 q) {
  vec3 v = texelFetch(t, clamp(q, ivec2(0), u_size - 1), 0).rgb;
  float ok = v.r > 0.5 / 255.0 ? 1.0 : 0.0;
  return vec4(u_minK + v * u_spanK, ok);
}

// bilinear over the texels that have data
vec4 sampleK(sampler2D t, vec2 px) {
  vec2 p = px - 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = p - vec2(i);
  vec4 a = texK(t, i), b = texK(t, i + ivec2(1, 0)), c = texK(t, i + ivec2(0, 1)), d = texK(t, i + ivec2(1, 1));
  float wa = (1.0 - f.x) * (1.0 - f.y) * a.w, wb = f.x * (1.0 - f.y) * b.w, wc = (1.0 - f.x) * f.y * c.w, wd = f.x * f.y * d.w;
  float w = wa + wb + wc + wd;
  if (w < 1e-4) return vec4(0.0);
  return vec4((a.rgb * wa + b.rgb * wb + c.rgb * wc + d.rgb * wd) / w, min(1.0, w * 1.5));
}

vec3 lerp3(vec3 a, vec3 b, float t) { return mix(a, b, clamp(t, 0.0, 1.0)); }

vec3 wvDiff(float d) {
  if (d < -30.0) return vec3(0.42, 0.24, 0.10);
  if (d < -20.0) return lerp3(vec3(0.42, 0.24, 0.10), vec3(0.85, 0.55, 0.25), (d + 30.0) / 10.0);
  if (d < -10.0) return lerp3(vec3(0.85, 0.55, 0.25), vec3(0.88, 0.86, 0.80), (d + 20.0) / 10.0);
  if (d < -3.0) return lerp3(vec3(0.88, 0.86, 0.80), vec3(0.55, 0.75, 1.0), (d + 10.0) / 7.0);
  if (d < 1.0) return lerp3(vec3(0.55, 0.75, 1.0), vec3(0.1, 0.3, 0.9), (d + 3.0) / 4.0);
  return lerp3(vec3(0.1, 0.3, 0.9), vec3(0.6, 0.2, 0.85), (d - 1.0) / 3.0);
}

float quantity(int s, vec3 k) {
  if (s == 0) return k.r;
  if (s == 1) return k.g;
  if (s == 2) return k.b;
  if (s == 3) return k.g - k.b;
  return k.r - k.b;
}

float wmo(float v, vec2 range, float gamma) {
  float x = clamp((v - range.x) / (range.y - range.x), 0.0, 1.0);
  return pow(x, 1.0 / max(gamma, 0.05));
}

vec4 shade(vec4 s) {
  if (s.a <= 0.0) return vec4(0.0);
  if (u_mode == 0) {
    vec4 c = texture(u_lut, vec2(clamp((s.r - u_minK) / u_spanK, 0.0, 1.0), 0.5));
    return vec4(c.rgb * c.a * s.a, c.a * s.a);
  }
  vec3 rgb;
  if (u_mode == 1) rgb = wvDiff(s.g - s.b);
  else rgb = vec3(wmo(quantity(u_src.x, s.rgb), u_rangeR, u_gamma.x), wmo(quantity(u_src.y, s.rgb), u_rangeG, u_gamma.y), wmo(quantity(u_src.z, s.rgb), u_rangeB, u_gamma.z));
  return vec4(rgb * s.a, s.a);
}

void main() {
  vec2 uv = vec2((v_merc.x - u_box.x) / (u_box.z - u_box.x), (v_merc.y - u_box.y) / (u_box.w - u_box.y));
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  vec2 px = uv * vec2(u_size);
  vec4 c = shade(sampleK(u_a, px));
  if (u_hasB == 1) c = mix(c, shade(sampleK(u_b, px)), u_mixB);
  o = c * u_opacity;
}`;

export interface SatelliteDataFrame {
  key: string;
  url: string;
}

interface Slot {
  bitmap: ImageBitmap | null;
  texture: WebGLTexture | null;
}

export interface DataLayerStyle {
  mode: 0 | 1 | 2;
  custom: readonly CustomChannel[];
}

export class SatelliteDataLayer implements CustomLayerInterface {
  readonly id = 'satellite-data-layer';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapLibreMap | null = null;
  private pending: PendingProgram | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private readonly slots = new Map<string, Slot>();
  private frames: readonly SatelliteDataFrame[] = [];
  private bounds: GeoBounds | null = null;
  private scale = { minK: 180, spanK: 140 };
  private position = 0;
  private opacity = 1;
  private style: DataLayerStyle = { mode: 0, custom: [] };
  private size: [number, number] = [1, 1];
  private lut: WebGLTexture | null = null;
  private lutFor = '';

  setFrames(frames: readonly SatelliteDataFrame[], bounds: GeoBounds, minK: number, spanK: number): void {
    this.frames = frames;
    this.scale = { minK, spanK };
    if (bounds !== this.bounds) {
      this.bounds = bounds;
      this.writeQuad();
    }
    const keep = new Set(frames.map(f => f.key));
    for (const [key, slot] of this.slots) {
      if (keep.has(key)) continue;
      slot.bitmap?.close();
      if (slot.texture && this.gl) this.gl.deleteTexture(slot.texture);
      this.slots.delete(key);
    }
    for (const f of frames) if (!this.slots.has(f.key)) void this.load(f);
    this.map?.triggerRepaint();
  }

  setPosition(position: number, opacity: number): void {
    this.position = position;
    this.opacity = opacity;
    this.map?.triggerRepaint();
  }

  setStyle(style: DataLayerStyle): void {
    this.style = style;
    this.map?.triggerRepaint();
  }

  private async load(frame: SatelliteDataFrame): Promise<void> {
    const slot: Slot = { bitmap: null, texture: null };
    this.slots.set(frame.key, slot);
    try {
      const blob = await (await fetch(frame.url)).blob();
      // the bytes as they are: no colour management or premultiplication may touch the temperatures
      const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      if (this.slots.get(frame.key) !== slot) {
        bitmap.close();
        return;
      }
      slot.bitmap = bitmap;
      this.map?.triggerRepaint();
    } catch {
      // the next refresh of the list tries again
      this.slots.delete(frame.key);
    }
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    this.pending = new PendingProgram(gl, VERTEX, FRAGMENT, 'satellite data');
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    this.writeQuad();
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    for (const slot of this.slots.values()) slot.texture = null;
  }

  private writeQuad(): void {
    const gl = this.gl;
    const b = this.bounds;
    if (!gl || !this.vbo || !b) return;
    const x0 = mercatorUnitX(b.west), x1 = mercatorUnitX(b.east), y0 = mercatorUnitY(b.north), y1 = mercatorUnitY(b.south);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x0, y0, x1, y0, x0, y1, x1, y1]), gl.STATIC_DRAW);
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    for (const slot of this.slots.values()) {
      slot.bitmap?.close();
      if (slot.texture) gl.deleteTexture(slot.texture);
    }
    this.slots.clear();
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    const handle = this.program ?? this.pending?.handle;
    if (handle) gl.deleteProgram(handle);
    if (this.lut) gl.deleteTexture(this.lut);
    this.lut = null;
    this.lutFor = '';
    this.pending = null;
    this.program = this.vbo = this.vao = null;
    this.map = null;
    this.gl = null;
  }

  private textureOf(gl: WebGL2RenderingContext, frame: SatelliteDataFrame): WebGLTexture | null {
    const slot = this.slots.get(frame.key);
    if (!slot) return null;
    if (!slot.texture && slot.bitmap) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, slot.bitmap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.size = [slot.bitmap.width, slot.bitmap.height];
      slot.texture = tex;
      slot.bitmap.close();
      slot.bitmap = null;
    }
    return slot.texture;
  }

  /** Windy's infrared colours for this data's temperature scale, made once. */
  private lutTexture(gl: WebGL2RenderingContext): WebGLTexture {
    const key = `${this.scale.minK}|${this.scale.spanK}`;
    if (!this.lut || this.lutFor !== key) {
      if (this.lut) gl.deleteTexture(this.lut);
      this.lut = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.lut);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, windyInfraredTable(this.scale.minK, this.scale.spanK, 256));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.lutFor = key;
    }
    return this.lut;
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.program) {
      const p = this.pending?.ready();
      if (!p) {
        if (this.pending) this.map?.triggerRepaint();
        return;
      }
      this.program = p;
      for (const name of ['u_matrix', 'u_a', 'u_b', 'u_box', 'u_size', 'u_mixB', 'u_hasB', 'u_opacity', 'u_mode', 'u_minK', 'u_spanK', 'u_src',
        'u_rangeR', 'u_rangeG', 'u_rangeB', 'u_gamma', 'u_lut']) {
        this.uniforms[name] = gl.getUniformLocation(p, name);
      }
    }
    const n = this.frames.length;
    const b = this.bounds;
    if (n === 0 || !b || this.opacity <= 0.001) return;
    const base = Math.min(Math.max(Math.floor(this.position), 0), n - 1);
    const frac = Math.min(Math.max(this.position - base, 0), 1);
    const a = this.textureOf(gl, this.frames[base]);
    if (!a) return;
    const next = frac > 0.001 && base + 1 < n ? this.textureOf(gl, this.frames[base + 1]) : null;
    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, a);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, next ?? a);
    gl.uniformMatrix4fv(u['u_matrix'], false, options.defaultProjectionData.mainMatrix as unknown as Float32List);
    gl.uniform1i(u['u_a'], 0);
    gl.uniform1i(u['u_b'], 1);
    gl.uniform4f(u['u_box'], mercatorUnitX(b.west), mercatorUnitY(b.north), mercatorUnitX(b.east), mercatorUnitY(b.south));
    gl.uniform2i(u['u_size'], this.size[0], this.size[1]);
    gl.uniform1f(u['u_mixB'], next ? frac : 0);
    gl.uniform1i(u['u_hasB'], next ? 1 : 0);
    gl.uniform1f(u['u_opacity'], this.opacity);
    gl.uniform1i(u['u_mode'], this.style.mode);
    gl.uniform1f(u['u_minK'], this.scale.minK);
    gl.uniform1f(u['u_spanK'], this.scale.spanK);
    const c = this.style.custom;
    const ch = (i: number) => c[i] ?? { source: 0, min: 180, max: 320, gamma: 1 };
    gl.uniform3i(u['u_src'], ch(0).source, ch(1).source, ch(2).source);
    gl.uniform2f(u['u_rangeR'], ch(0).min, ch(0).max);
    gl.uniform2f(u['u_rangeG'], ch(1).min, ch(1).max);
    gl.uniform2f(u['u_rangeB'], ch(2).min, ch(2).max);
    gl.uniform3f(u['u_gamma'], ch(0).gamma, ch(1).gamma, ch(2).gamma);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture(gl));
    gl.uniform1i(u['u_lut'], 2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
