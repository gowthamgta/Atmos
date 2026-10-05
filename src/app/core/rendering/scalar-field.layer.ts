import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { ForecastGrid, mercatorUnitX, mercatorUnitY } from '../forecast/forecast.model';
import { ForecastLayerDef, buildPaletteLut } from '../forecast/forecast-layers';
import { LAPSE_RATE_C_PER_M, MAX_TERRAIN_DELTA_M, RH_LOG_PER_M } from '../forecast/terrain-correction';
import type { TerrainData } from '../forecast/terrain.service';

const VERTEX = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;
out vec2 v_merc;
void main() {
  v_merc = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

/**
 * Fields are rg16 PNGs (R = high byte, G = low byte, B = 255 for "no data"). The GPU cannot filter those
 * bytes directly, so every texel is fetched exactly, decoded, and interpolated here (space and time).
 */
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_a2;      // second component (vector layers), time A
uniform sampler2D u_b2;      // second component, time B
uniform sampler2D u_lut;
uniform sampler2D u_dem;       // 1 km terrain
uniform sampler2D u_demModel;  // terrain averaged to the forecast grid (what the model thinks the ground is)
uniform float u_mix;
uniform float u_opacity;
uniform vec2 u_enc;      // value range of the 16-bit encoding
uniform vec2 u_disp;     // display range mapped onto the palette
uniform float u_gamma;
uniform float u_clear;
uniform vec4 u_grid;     // lonMin, latMax, step, unused
uniform ivec2 u_size;
uniform vec4 u_demGrid;    // fine terrain: lonMin, latMax, step, unused
uniform ivec2 u_demSize;
uniform vec2 u_demEnc;     // terrain value range of its 16-bit encoding
uniform int u_magnitude;   // 1: show hypot(first, second component) e.g. wind speed from u and v
uniform int u_terrainMode; // 0 off, 1 temperature, 2 humidity
uniform vec3 u_terrain;    // lapse rate (C/m), humidity log-gain (1/m), max height difference (m)
in vec2 v_merc;
out vec4 outColor;

const float PI = 3.14159265358979;

// Returns (value, weight of valid neighbours).
vec2 sampleField(sampler2D tex, vec2 g, ivec2 size, vec2 enc) {
  vec2 f = fract(g);
  ivec2 i0 = ivec2(floor(g));
  float sum = 0.0;
  float wsum = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    ivec2 p = clamp(i0 + o, ivec2(0), size - 1);
    float w = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    vec4 c = texelFetch(tex, p, 0);
    if (c.b > 0.5) continue;
    float q = floor(c.r * 255.0 + 0.5) * 256.0 + floor(c.g * 255.0 + 0.5);
    sum += (enc.x + q / 65535.0 * (enc.y - enc.x)) * w;
    wsum += w;
  }
  return vec2(wsum > 0.001 ? sum / wsum : 0.0, wsum);
}

// Blends two time steps of one variable; where one step has no data the other is used. Returns (value, valid).
vec2 blendTime(sampler2D ta, sampler2D tb, vec2 g) {
  vec2 a = sampleField(ta, g, u_size, u_enc);
  vec2 b = sampleField(tb, g, u_size, u_enc);
  float wa = (1.0 - u_mix) * (a.y > 0.5 ? 1.0 : 0.0);
  float wb = u_mix * (b.y > 0.5 ? 1.0 : 0.0);
  if (wa + wb < 0.0001) return vec2(0.0, 0.0);
  return vec2((a.x * wa + b.x * wb) / (wa + wb), 1.0);
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

  vec2 first = blendTime(u_a, u_b, g);
  if (first.y < 0.5) discard;              // no data at either time
  float v = first.x;
  if (u_magnitude == 1) {
    vec2 second = blendTime(u_a2, u_b2, g);
    if (second.y < 0.5) discard;
    v = length(vec2(first.x, second.x));
  }

  if (u_terrainMode != 0) {
    vec2 gf = clamp(vec2((lon - u_demGrid.x) / u_demGrid.z, (u_demGrid.y - lat) / u_demGrid.z), vec2(0.0), vec2(u_demSize) - 1.0001);
    float zFine = sampleField(u_dem, gf, u_demSize, u_demEnc).x;
    float zModel = sampleField(u_demModel, g, u_size, u_demEnc).x;
    float dz = clamp(zFine - zModel, -u_terrain.z, u_terrain.z);
    if (u_terrainMode == 1) v -= u_terrain.x * dz;
    else v = min(100.0, v * exp(u_terrain.y * dz));
  }

  float t = clamp((v - u_disp.x) / (u_disp.y - u_disp.x), 0.0, 1.0);
  t = pow(t, u_gamma);
  vec4 lut = texture(u_lut, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
  float alpha = u_opacity * edgeFade;
  if (u_clear > 0.0) alpha *= smoothstep(u_clear, u_clear * 1.5, v);
  outColor = vec4(lut.rgb * alpha, alpha);   // premultiplied for MapLibre's blend function
}`;

export interface FieldFrame {
  /** Unique key of the image (run/var/step) so textures can be reused. */
  key: string;
  bitmap: ImageBitmap;
}

interface Uniforms {
  [name: string]: WebGLUniformLocation | null;
}

/** MapLibre custom layer drawing one forecast variable, blended between two time steps on the GPU. */
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
  private static readonly MAX_TEXTURES = 10;

  private grid: ForecastGrid | null = null;
  private def: ForecastLayerDef | null = null;
  private enc: [number, number] = [0, 1];
  private frameA: FieldFrame | null = null;
  private frameB: FieldFrame | null = null;
  private frameA2: FieldFrame | null = null;
  private frameB2: FieldFrame | null = null;
  private mix = 0;
  private lutFor: ForecastLayerDef | null = null;
  private terrain: TerrainData | null = null;
  private demTex: WebGLTexture | null = null;
  private demModelTex: WebGLTexture | null = null;
  private demUploaded = false;
  private visible = false;

  /** Static grid geometry; call before the first frame. */
  setGrid(grid: ForecastGrid): void {
    if (this.grid === grid) return;
    this.grid = grid;
    this.uploadQuad();
  }

  /** Show a variable (or hide with null). `enc` is the manifest's [min, max] encoding range for it. */
  setLayer(def: ForecastLayerDef | null, enc?: [number, number]): void {
    this.def = def;
    if (enc) this.enc = enc;
    this.visible = def !== null;
    this.map?.triggerRepaint();
  }

  /** Provide (or clear) the static terrain used for the per-pixel height correction. */
  setTerrain(data: TerrainData | null): void {
    if (this.terrain === data) return;
    this.terrain = data;
    this.demUploaded = false;
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

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    const program = this.link(gl, VERTEX, FRAGMENT);
    this.program = program;
    this.uniforms = {};
    for (const name of ['u_matrix', 'u_a', 'u_b', 'u_lut', 'u_a2', 'u_b2', 'u_magnitude', 'u_dem', 'u_demModel', 'u_demGrid', 'u_demSize', 'u_demEnc', 'u_terrainMode', 'u_terrain', 'u_mix', 'u_opacity', 'u_enc', 'u_disp', 'u_gamma', 'u_clear', 'u_grid', 'u_size']) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.lutTex = gl.createTexture();
    this.demTex = gl.createTexture();
    this.demModelTex = gl.createTexture();
    this.demUploaded = false;
    this.uploadQuad();
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    for (const tex of this.textures.values()) gl.deleteTexture(tex);
    this.textures.clear();
    if (this.lutTex) gl.deleteTexture(this.lutTex);
    if (this.demTex) gl.deleteTexture(this.demTex);
    if (this.demModelTex) gl.deleteTexture(this.demModelTex);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.lutTex = this.demTex = this.demModelTex = this.vbo = this.vao = this.program = null;
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
    const terrainMode = this.terrain && this.demUploaded ? (def.terrain === 'temperature' ? 1 : def.terrain === 'humidity' ? 2 : 0) : 0;

    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texA);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texB);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    if (magnitude) {
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, texA2);
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, texB2);
    }
    if (terrainMode !== 0) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.demTex);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.demModelTex);
    }

    const u = this.uniforms;
    gl.uniformMatrix4fv(u['u_matrix'], false, options.defaultProjectionData.mainMatrix as unknown as Float32List);
    gl.uniform1i(u['u_a'], 0);
    gl.uniform1i(u['u_b'], 1);
    gl.uniform1i(u['u_lut'], 2);
    gl.uniform1i(u['u_a2'], magnitude ? 5 : 0);
    gl.uniform1i(u['u_b2'], magnitude ? 6 : 0);
    gl.uniform1i(u['u_magnitude'], magnitude ? 1 : 0);
    gl.uniform1f(u['u_mix'], this.mix);
    gl.uniform1f(u['u_opacity'], def.opacity);
    gl.uniform2f(u['u_enc'], this.enc[0], this.enc[1]);
    gl.uniform2f(u['u_disp'], def.min, def.max);
    gl.uniform1f(u['u_gamma'], def.gamma);
    gl.uniform1f(u['u_clear'], def.clearBelow);
    gl.uniform4f(u['u_grid'], grid.lonMin, grid.latMax, grid.step, 0);
    gl.uniform2i(u['u_size'], grid.nx, grid.ny);
    gl.uniform1i(u['u_terrainMode'], terrainMode);
    if (terrainMode !== 0 && this.terrain) {
      const { meta } = this.terrain;
      gl.uniform1i(u['u_dem'], 3);
      gl.uniform1i(u['u_demModel'], 4);
      gl.uniform4f(u['u_demGrid'], meta.fine.lonMin, meta.fine.latMax, meta.fine.step, 0);
      gl.uniform2i(u['u_demSize'], meta.fine.nx, meta.fine.ny);
      gl.uniform2f(u['u_demEnc'], meta.min, meta.max);
      gl.uniform3f(u['u_terrain'], LAPSE_RATE_C_PER_M, RH_LOG_PER_M, MAX_TERRAIN_DELTA_M);
    } else {
      // Unused samplers must not alias unit 0 with a different sampler type; point them at a bound unit.
      gl.uniform1i(u['u_dem'], 0);
      gl.uniform1i(u['u_demModel'], 0);
      gl.uniform2i(u['u_demSize'], 1, 1);
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

  private uploadTerrain(gl: WebGL2RenderingContext, data: TerrainData): void {
    const upload = (tex: WebGLTexture | null, bitmap: ImageBitmap) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    upload(this.demTex, data.fine);
    upload(this.demModelTex, data.model);
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
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame.bitmap);
    // NEAREST is required: the shader decodes exact bytes and interpolates the decoded values itself.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(frame.key, tex);
    while (this.textures.size > ScalarFieldLayer.MAX_TEXTURES) {
      const oldest = this.textures.keys().next().value as string;
      if ([this.frameA, this.frameB, this.frameA2, this.frameB2].some(f => f?.key === oldest)) break;
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
