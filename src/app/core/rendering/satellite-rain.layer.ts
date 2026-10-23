import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { mercatorUnitX, mercatorUnitY } from '../forecast/forecast.model';
import type { GeoBounds } from '../satellite/satellite.config';
import { bandGlsl, rampGlsl } from './radar-field.layer';
import { PendingProgram } from './gl-program';

/**
 * Rain estimated from the satellite where no radar sees: from the newest Meteosat frame's measured cloud-top temperatures (our own data pack,
 * pipeline/meteosat_rgb.py: red = 10.8 um, green = 6.2 um, kelvin = minK + v x spanK), drawn in the radar's colours under the radar echoes and
 * left out inside the range of every radar that works.
 *
 * The rain rate is NOAA's Auto-Estimator (Vicente, Scofield and Menzel 1998, BAMS 79): R = 1.1183e11 exp(-0.036382 T^1.2) mm/h for a cloud top
 * of T kelvin, which gives about 1 mm/h at 240 K, 10 at 215 K and the cap of 72 at 195 K. Only deep cloud counts: the top colder than 240 K and
 * no more than 8 K warmer than the 6.2 um water-vapour channel (a top that high is near the 6.2 um level; thin cirrus, much warmer at 10.8 than
 * at 6.2, does not rain), and, as in the Hydro-Estimator, full rain only in the cores colder than the cloud about 25 km around (flat anvils a
 * fifth). It is an estimate (rain under warm low cloud is missed, and an anvil can rain less than its top says), so it is drawn
 * fainter than the radar and named as an estimate in the panel. The rate is shown as the dBZ a radar would see for it (Z = 200 R^1.6).
 */
const VERTEX = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;
out vec2 v_merc;
void main() {
  v_merc = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const MAX_DISCS = 64;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_data;
uniform vec4 u_box;          // mercator x0, y0 (top), x1, y1 of the data pack
uniform float u_minK;
uniform float u_spanK;
uniform float u_opacity;
uniform vec3 u_discs[${MAX_DISCS}];   // the working radars: mercator x, y and range
uniform int u_discCount;
in vec2 v_merc;
out vec4 o;

${rampGlsl()}
${bandGlsl()}

// the temperatures (K) at a place, bilinear over the texels that have data (0 means none: blending it in would fake a cold top);
// w = how much of the neighbourhood has data
vec4 temps(vec2 uv) {
  ivec2 size = textureSize(u_data, 0);
  vec2 p = uv * vec2(size) - 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = p - vec2(i);
  vec3 sum = vec3(0.0);
  float w = 0.0;
  for (int dy = 0; dy <= 1; dy++) for (int dx = 0; dx <= 1; dx++) {
    vec3 v = texelFetch(u_data, clamp(i + ivec2(dx, dy), ivec2(0), size - 1), 0).rgb;
    float k = (dx == 0 ? 1.0 - f.x : f.x) * (dy == 0 ? 1.0 - f.y : f.y) * (v.r > 0.5 / 255.0 ? 1.0 : 0.0);
    sum += v * k;
    w += k;
  }
  if (w < 1e-4) return vec4(0.0);
  return vec4(sum / w * u_spanK + u_minK, w);
}

void main() {
  vec2 uv = vec2((v_merc.x - u_box.x) / (u_box.z - u_box.x), (v_merc.y - u_box.y) / (u_box.w - u_box.y));
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  // inside a working radar's range the radar is shown instead; a short fade at the edge of its range
  float outside = 1.0;
  for (int i = 0; i < ${MAX_DISCS}; i++) {
    if (i >= u_discCount) break;
    float d = distance(v_merc, u_discs[i].xy) / u_discs[i].z;
    outside = min(outside, smoothstep(0.92, 1.0, d));
  }
  if (outside <= 0.0) discard;
  vec4 t = temps(uv);
  if (t.a < 0.5) discard;                         // no data here
  float ir = t.r, wv = t.g;
  if (ir > 240.0 || ir - wv > 8.0) discard;      // not deep cloud
  float rate = min(72.0, 1.1183e11 * exp(-0.036382 * pow(ir, 1.2)));
  // as NOAA's Hydro-Estimator does: full rain only where the top is colder than the cloud around it (a convective core); a flat anvil
  // sheet, as cold as its surroundings, gets a fifth of it. The surroundings: the mean of 8 points about 25 km away
  vec2 r = 25.0 / 3.0 / vec2(textureSize(u_data, 0)) * vec2(1.0, 1.0);
  float around = 0.0, n = 0.0;
  for (int k = 0; k < 8; k++) {
    float ang = float(k) * 0.785398;
    vec4 q = temps(uv + vec2(cos(ang), sin(ang)) * r);
    if (q.a > 0.5) { around += q.r; n += 1.0; }
  }
  float core = n > 0.0 ? smoothstep(0.0, 8.0, around / n - ir) : 0.5;
  rate *= mix(0.2, 1.0, core);
  if (rate < 0.3) discard;
  float dbz = 10.0 * log(200.0 * pow(rate, 1.6)) / log(10.0);
  vec4 c = band((dbz - 12.0) / 9.6);
  // the edge of the estimate fades in over the first millimetre an hour
  float a = c.a * smoothstep(0.3, 1.0, rate) * outside * u_opacity * 0.6;   // fainter than the radar: an estimate
  o = vec4(c.rgb * a, a);
}`;

export interface RadarDisc {
  lat: number;
  lng: number;
  rangeKm: number;
}

export class SatelliteRainLayer implements CustomLayerInterface {
  readonly id = 'satellite-rain-layer';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private pending: PendingProgram | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private texture: WebGLTexture | null = null;
  private bitmap: ImageBitmap | null = null;
  private bounds: GeoBounds | null = null;
  private scale = { minK: 180, spanK: 140 };
  private discs = new Float32Array(MAX_DISCS * 3);
  private discCount = 0;
  private opacity = 1;
  private url = '';

  /** The data pack to draw from (its address, the box it covers and its temperature scale). */
  async setData(url: string, bounds: GeoBounds, minK: number, spanK: number): Promise<void> {
    if (url === this.url) return;
    this.url = url;
    try {
      const blob = await (await fetch(url)).blob();
      const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      if (url !== this.url) return bitmap.close();
      this.bitmap?.close();
      this.bitmap = bitmap;
      if (this.texture && this.gl) this.gl.deleteTexture(this.texture);
      this.texture = null;
      this.bounds = bounds;
      this.scale = { minK, spanK };
      this.writeQuad();
      this.map?.triggerRepaint();
    } catch {
      this.url = '';
    }
  }

  /** The radars that work: no estimate is drawn inside their range. */
  setRadars(radars: readonly RadarDisc[]): void {
    this.discs.fill(0);
    const list = radars.slice(0, MAX_DISCS);
    list.forEach((r, i) => {
      const x = mercatorUnitX(r.lng);
      const y = mercatorUnitY(r.lat);
      // the range in mercator units at the radar's latitude
      const range = (r.rangeKm / 40_075.017) / Math.cos((r.lat * Math.PI) / 180);
      this.discs.set([x, y, range], i * 3);
    });
    this.discCount = list.length;
    this.map?.triggerRepaint();
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    this.pending = new PendingProgram(gl, VERTEX, FRAGMENT, 'satellite rain');
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    this.writeQuad();
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.texture = null;
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
    if (this.texture) gl.deleteTexture(this.texture);
    this.bitmap?.close();
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    const handle = this.program ?? this.pending?.handle;
    if (handle) gl.deleteProgram(handle);
    this.texture = this.vbo = this.vao = this.program = null;
    this.bitmap = null;
    this.pending = null;
    this.map = null;
    this.gl = null;
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.program) {
      const p = this.pending?.ready();
      if (!p) {
        if (this.pending) this.map?.triggerRepaint();
        return;
      }
      this.program = p;
      for (const n of ['u_matrix', 'u_data', 'u_box', 'u_minK', 'u_spanK', 'u_opacity', 'u_discs', 'u_discCount']) this.uniforms[n] = gl.getUniformLocation(p, n);
    }
    const b = this.bounds;
    if (!b || this.opacity <= 0.001) return;
    if (!this.texture && this.bitmap) {
      this.texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.bitmap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.bitmap.close();
      this.bitmap = null;
    }
    if (!this.texture) return;
    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniformMatrix4fv(u['u_matrix'], false, options.defaultProjectionData.mainMatrix as unknown as Float32List);
    gl.uniform1i(u['u_data'], 0);
    gl.uniform4f(u['u_box'], mercatorUnitX(b.west), mercatorUnitY(b.north), mercatorUnitX(b.east), mercatorUnitY(b.south));
    gl.uniform1f(u['u_minK'], this.scale.minK);
    gl.uniform1f(u['u_spanK'], this.scale.spanK);
    gl.uniform1f(u['u_opacity'], this.opacity);
    gl.uniform3fv(u['u_discs'], this.discs);
    gl.uniform1i(u['u_discCount'], this.discCount);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
