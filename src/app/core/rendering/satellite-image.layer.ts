import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { mercatorUnitX, mercatorUnitY } from '../forecast/forecast.model';
import { SATELLITE_BOUNDS } from '../satellite/satellite.config';

const VERTEX = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;
out vec2 v_merc;
void main() {
  v_merc = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

/**
 * The satellite picture is far coarser than a zoomed-in screen (one satellite pixel is 1-3 km), and the browser's own
 * bilinear magnification turns that into square, blobby patches. Here the picture is magnified with a bicubic
 * (Catmull-Rom) filter, which keeps the gradients smooth and round, with a touch of sharpening so cloud edges and the
 * fine texture of the visible picture stay crisp. Zoomed out, where many picture pixels fall on one screen pixel, the
 * hardware's mipmapped filter is used instead so it does not shimmer.
 *
 * Pictures are premultiplied RGBA, so cloud edges (transparent land and sea) blend without dark or bright fringes.
 */
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform vec4 u_box;       // mercator x0, y0 (top), x1, y1 (bottom) of the picture
uniform ivec2 u_size;
uniform float u_mixB;     // 0..1: how much of picture B is faded in over A
uniform float u_opacity;
uniform float u_sharpen;
uniform float u_soft;      // 0..1: how much of a smoother (half-resolution) read is mixed in, to hide the satellite's pixels
uniform int u_hasB;
uniform float u_wide;      // weight of the wider (4 picture pixel) blur scale in the sharpening; 0 = one scale only
in vec2 v_merc;
out vec4 outColor;

vec4 weights(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}

vec4 bicubic(sampler2D tex, vec2 px) {
  vec2 p = px - 0.5;
  ivec2 i1 = ivec2(floor(p));
  vec2 f = p - vec2(i1);
  vec4 wx = weights(f.x);
  vec4 wy = weights(f.y);
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      ivec2 q = clamp(i1 + ivec2(i - 1, j - 1), ivec2(0), u_size - 1);
      sum += texelFetch(tex, q, 0) * (wx[i] * wy[j]);
    }
  }
  return clamp(sum, 0.0, 1.0);
}

// Bicubic read of one mip level (the picture blurred and halved \`lod\` times), smooth like the main read.
vec4 bicubicLod(sampler2D tex, vec2 px, int lod) {
  ivec2 size = max(u_size >> lod, ivec2(1));
  vec2 p = px / float(1 << lod) - 0.5;
  ivec2 i1 = ivec2(floor(p));
  vec2 f = p - vec2(i1);
  vec4 wx = weights(f.x);
  vec4 wy = weights(f.y);
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      ivec2 q = clamp(i1 + ivec2(i - 1, j - 1), ivec2(0), size - 1);
      sum += texelFetch(tex, q, lod) * (wx[i] * wy[j]);
    }
  }
  return clamp(sum, 0.0, 1.0);
}

vec4 sampleFrame(sampler2D tex, vec2 uv, vec2 px, vec2 gx, vec2 gy, bool magnifying) {
  if (!magnifying) return textureGrad(tex, uv, gx, gy); // explicit gradients: safe inside a per-pixel branch
  vec4 c = bicubic(tex, px);
  if (u_soft > 0.0) c = mix(c, bicubicLod(tex, px, 1), u_soft);
  if (u_sharpen > 0.0) {
    // Unsharp mask: add back the difference between the picture and a smooth blur of itself (two and four picture
    // pixels wide), so cloud edges and the fine texture of the visible picture stand out. Applied to the colour only;
    // the blur is read bicubically too, so it adds no blockiness of its own.
    vec4 fine = bicubicLod(tex, px, 1);
    vec3 detail = (c.rgb - fine.rgb);
    if (u_wide > 0.0) detail += u_wide * (fine.rgb - bicubicLod(tex, px, 2).rgb);
    c.rgb = clamp(c.rgb + u_sharpen * detail * c.a, 0.0, c.a);
  }
  return c;
}

void main() {
  vec2 uv = vec2((v_merc.x - u_box.x) / (u_box.z - u_box.x), (v_merc.y - u_box.y) / (u_box.w - u_box.y));
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  vec2 px = uv * vec2(u_size);
  vec2 gx = dFdx(uv);
  vec2 gy = dFdy(uv);
  bool magnifying = max(length(gx * vec2(u_size)), length(gy * vec2(u_size))) < 1.0;

  vec4 c = sampleFrame(u_a, uv, px, gx, gy, magnifying);
  if (u_hasB == 1) {
    vec4 b = sampleFrame(u_b, uv, px, gx, gy, magnifying);
    c = mix(c, b, u_mixB); // premultiplied: a plain mix cross-fades colour and cloud cover together
  }
  // fade the picture's own border so it does not end in a hard line
  vec2 e = min(uv, 1.0 - uv) * vec2(u_size);
  c *= smoothstep(0.0, 6.0, min(e.x, e.y));
  outColor = c * u_opacity;
}`;

export interface SatelliteLayerFrame {
  /** Unique key of the picture (its object URL). */
  key: string;
  url: string;
}

interface Slot {
  bitmap: ImageBitmap | null;
  texture: WebGLTexture | null;
  failed: boolean;
}

/** MapLibre custom layer drawing the Meteosat picture with smooth magnification and a GPU cross-fade between two pictures. */
export class SatelliteImageLayer implements CustomLayerInterface {
  readonly id = 'satellite-image-layer';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly slots = new Map<string, Slot>();
  private frames: SatelliteLayerFrame[] = [];
  private position = 0;
  private opacity = 0.9;
  private look: 'picture' | 'clouds' | 'soft' = 'soft';
  private lite = false;

  /** The pictures of the loop, oldest first. Pictures no longer listed are released. */
  setFrames(frames: readonly SatelliteLayerFrame[]): void {
    this.frames = [...frames];
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

  /**
   * What is being shown. The full picture is the satellite's own image, so it only gets a gentle lift (smooth bicubic
   * magnification and mild sharpening); the cloud-only picture is a rendering of our own and takes stronger sharpening.
   */
  setLook(look: 'picture' | 'clouds' | 'soft'): void {
    this.look = look;
    this.map?.triggerRepaint();
  }

  /** Phone mode: one blur scale instead of two in the sharpening (about half the texture reads when zoomed in). */
  setLite(lite: boolean): void {
    this.lite = lite;
    this.map?.triggerRepaint();
  }

  /** Where the loop is (a frame number with a fraction while playing) and the overall opacity. */
  setPosition(position: number, opacity: number): void {
    this.position = position;
    this.opacity = opacity;
    this.map?.triggerRepaint();
  }

  private async load(frame: SatelliteLayerFrame): Promise<void> {
    const slot: Slot = { bitmap: null, texture: null, failed: false };
    this.slots.set(frame.key, slot);
    try {
      const blob = await (await fetch(frame.url)).blob();
      // premultiplied, so cloud edges blend cleanly when filtered
      const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
      if (this.slots.get(frame.key) !== slot) {
        bitmap.close(); // released while it was loading
        return;
      }
      slot.bitmap = bitmap;
      this.map?.triggerRepaint();
    } catch {
      slot.failed = true;
    }
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    const compile = (type: number, src: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`satellite shader: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`satellite program: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    for (const name of ['u_matrix', 'u_a', 'u_b', 'u_box', 'u_size', 'u_mixB', 'u_opacity', 'u_sharpen', 'u_soft', 'u_hasB', 'u_wide']) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    const b = SATELLITE_BOUNDS;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const x0 = mercatorUnitX(b.west);
    const x1 = mercatorUnitX(b.east);
    const y0 = mercatorUnitY(b.north);
    const y1 = mercatorUnitY(b.south);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x0, y0, x1, y0, x0, y1, x1, y1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    // textures already loaded for an earlier GL context are re-uploaded
    for (const slot of this.slots.values()) slot.texture = null;
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    for (const slot of this.slots.values()) {
      slot.bitmap?.close();
      if (slot.texture) gl.deleteTexture(slot.texture);
    }
    this.slots.clear();
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.vbo = this.vao = this.program = null;
    this.map = null;
    this.gl = null;
  }

  /** The texture of a picture, uploaded on first use (its bitmap is released once it is on the GPU). */
  private textureOf(gl: WebGL2RenderingContext, frame: SatelliteLayerFrame): { texture: WebGLTexture; w: number; h: number } | null {
    const slot = this.slots.get(frame.key);
    if (!slot) return null;
    if (!slot.texture && slot.bitmap) {
      const { width, height } = slot.bitmap;
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, slot.bitmap);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      slot.texture = tex;
      slot.bitmap.close();
      slot.bitmap = null;
      this.size = [width, height];
    }
    return slot.texture ? { texture: slot.texture, w: this.size[0], h: this.size[1] } : null;
  }

  private size: [number, number] = [1, 1];

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const program = this.program;
    const n = this.frames.length;
    if (!program || n === 0 || this.opacity <= 0.001) return;
    const base = Math.min(Math.max(Math.floor(this.position), 0), n - 1);
    const frac = Math.min(Math.max(this.position - base, 0), 1);
    const a = this.textureOf(gl, this.frames[base]);
    if (!a) return;
    const nextFrame = frac > 0.001 && base + 1 < n ? this.frames[base + 1] : null;
    const b = nextFrame ? this.textureOf(gl, nextFrame) : null;

    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, a.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b ? b.texture : a.texture);
    const u = this.uniforms;
    const bounds = SATELLITE_BOUNDS;
    gl.uniformMatrix4fv(u['u_matrix'], false, options.defaultProjectionData.mainMatrix as unknown as Float32List);
    gl.uniform1i(u['u_a'], 0);
    gl.uniform1i(u['u_b'], 1);
    gl.uniform4f(u['u_box'], mercatorUnitX(bounds.west), mercatorUnitY(bounds.north), mercatorUnitX(bounds.east), mercatorUnitY(bounds.south));
    gl.uniform2i(u['u_size'], a.w, a.h);
    gl.uniform1f(u['u_mixB'], b ? frac : 0);
    gl.uniform1f(u['u_opacity'], this.opacity);
    gl.uniform1f(u['u_sharpen'], this.look === 'soft' ? 0 : this.look === 'clouds' ? 1.2 : 0.45);
    gl.uniform1f(u['u_soft'], this.look === 'soft' ? 0.55 : 0);
    gl.uniform1i(u['u_hasB'], b ? 1 : 0);
    gl.uniform1f(u['u_wide'], this.lite || this.look !== 'clouds' ? 0 : 0.5);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
