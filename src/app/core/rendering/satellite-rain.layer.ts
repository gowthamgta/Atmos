import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { mercatorUnitX, mercatorUnitY } from '../forecast/forecast.model';
import type { GeoBounds } from '../satellite/satellite.config';
import { bandGlsl, rampGlsl } from './radar-field.layer';
import { PendingProgram } from './gl-program';

/**
 * The synthetic radar (satellite/synthetic-radar.ts: satellite domes and new popups, the winds, the lightning), drawn in the radar's colours
 * under the radar echoes, left out of the whole range of every radar that works (the real radar is drawn there, as far as the product on
 * the map reaches) and fading in over the first 20 km past it, so the two never overlap.
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
uniform sampler2D u_field;    // reflectivity x 4 / 255
uniform vec4 u_box;          // mercator x0, y0 (top), x1, y1 of the field
uniform float u_opacity;
uniform vec4 u_discs[${MAX_DISCS}];   // the working radars: mercator x, y, range, and where the fade ends (fraction of the range, past 1)
uniform int u_discCount;
in vec2 v_merc;
out vec4 o;

${rampGlsl()}
${bandGlsl()}

void main() {
  vec2 uv = vec2((v_merc.x - u_box.x) / (u_box.z - u_box.x), (v_merc.y - u_box.y) / (u_box.w - u_box.y));
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  // inside a working radar's range the radar is shown instead; the estimate fades in over the first 20 km past it
  float outside = 1.0;
  for (int i = 0; i < ${MAX_DISCS}; i++) {
    if (i >= u_discCount) break;
    float d = distance(v_merc, u_discs[i].xy) / u_discs[i].z;
    outside = min(outside, smoothstep(1.0, u_discs[i].w, d));
  }
  if (outside <= 0.0) discard;
  float dbz = texture(u_field, uv).r * 255.0 / 4.0;
  if (dbz < 14.0) discard;
  vec4 c = band((dbz - 12.0) / 9.6);
  float a = c.a * smoothstep(14.0, 16.0, dbz) * outside * u_opacity * 0.85;   // a little fainter than the radar: an estimate
  o = vec4(c.rgb * a, a);
}`;

export interface RadarDisc {
  lat: number;
  lng: number;
  rangeKm: number;
}

/** The fade-in past the edge of a radar's range. */
const FEATHER_KM = 20;

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
  private field: { data: Uint8Array; w: number; h: number } | null = null;
  private bounds: GeoBounds | null = null;
  private discs = new Float32Array(MAX_DISCS * 4);
  private discCount = 0;
  private opacity = 1;

  /** The synthetic radar to draw: reflectivity x 4 per pixel over a Mercator box. */
  setField(data: Uint8Array, w: number, h: number, bounds: GeoBounds): void {
    if (this.field?.data === data) return;
    this.field = { data, w, h };
    this.bounds = bounds;
    if (this.texture && this.gl) this.gl.deleteTexture(this.texture);
    this.texture = null;
    this.writeQuad();
    this.map?.triggerRepaint();
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
      this.discs.set([x, y, range, 1 + FEATHER_KM / r.rangeKm], i * 4);
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
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    const handle = this.program ?? this.pending?.handle;
    if (handle) gl.deleteProgram(handle);
    this.texture = this.vbo = this.vao = this.program = null;
    this.field = null;
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
      for (const n of ['u_matrix', 'u_field', 'u_box', 'u_opacity', 'u_discs', 'u_discCount']) this.uniforms[n] = gl.getUniformLocation(p, n);
    }
    const b = this.bounds;
    if (!b || this.opacity <= 0.001) return;
    if (!this.texture && this.field) {
      this.texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.field.w, this.field.h, 0, gl.RED, gl.UNSIGNED_BYTE, this.field.data);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    if (!this.texture) return;
    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniformMatrix4fv(u['u_matrix'], false, options.defaultProjectionData.mainMatrix as unknown as Float32List);
    gl.uniform1i(u['u_field'], 0);
    gl.uniform4f(u['u_box'], mercatorUnitX(b.west), mercatorUnitY(b.north), mercatorUnitX(b.east), mercatorUnitY(b.south));
    gl.uniform1f(u['u_opacity'], this.opacity);
    gl.uniform4fv(u['u_discs'], this.discs);
    gl.uniform1i(u['u_discCount'], this.discCount);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
