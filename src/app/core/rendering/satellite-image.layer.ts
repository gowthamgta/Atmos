import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { mercatorUnitX, mercatorUnitY } from '../forecast/forecast.model';
import { GeoBounds, SATELLITE_BOUNDS } from '../satellite/satellite.config';

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
 * (Catmull-Rom) filter and enhanced with AMD FidelityFX CAS (Contrast Adaptive Sharpening).
 *
 * AMD FidelityFX CAS analyzes local contrast per texel: in flat areas (open sea, smooth sky) it applies zero sharpening
 * to prevent amplifying JPEG noise, while on high-contrast edges (cloud boundaries, convective cores, coastlines) it dynamically
 * applies sub-pixel sharpening without overshoot, dark fringes or halo ringing.
 *
 * Pictures are premultiplied RGBA, so cloud edges (transparent land and sea) blend without dark or bright fringes.
 *
 * A closer window of the same picture can sit over the whole-India one (see satellite-window.ts): the window fades out over a
 * feather at its edge (`u_feather`, in map units) and the whole-India layer, told where the window is, fades out inside it by the
 * same amount (`u_hole`), so the two always add up to one picture and the window shows no frame.
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
uniform float u_feather;   // > 0: fade the picture out over this much (map units) inside its own edge (a window over the main picture)
uniform vec4 u_hole;       // mercator box of a window drawn over this picture, which this picture fades out inside
uniform float u_holeFeather; // > 0 when there is a window to make room for
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

// AMD FidelityFX CAS (Contrast Adaptive Sharpening):
// Adapts sharpening to local contrast so edges are crisp while flat areas (ocean, sky) add zero noise.
vec3 casSharpen(sampler2D tex, vec2 px, vec3 c, float sharpness) {
  ivec2 ip = ivec2(floor(px));
  ivec2 maxCoord = u_size - 1;
  vec3 b = texelFetch(tex, clamp(ip + ivec2(0, -1), ivec2(0), maxCoord), 0).rgb;
  vec3 d = texelFetch(tex, clamp(ip + ivec2(-1, 0), ivec2(0), maxCoord), 0).rgb;
  vec3 f = texelFetch(tex, clamp(ip + ivec2(1, 0), ivec2(0), maxCoord), 0).rgb;
  vec3 h = texelFetch(tex, clamp(ip + ivec2(0, 1), ivec2(0), maxCoord), 0).rgb;

  // Local contrast bounds over cross neighborhood
  vec3 mn = min(min(min(b, d), min(f, h)), c);
  vec3 mx = max(max(max(b, d), max(f, h)), c);

  // AMD CAS contrast adaptation:
  // In flat regions (mn ≈ mx), amp approaches 0.
  // In high contrast regions, amp scales to prevent saturation clipping and ringing.
  vec3 amp = clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0);
  vec3 w = sqrt(amp) * (-0.16 * sharpness);

  // Filter: center + cross neighbors weighted by w, normalized by (1 + 4w)
  vec3 num = (b + d + f + h) * w + c;
  vec3 den = 1.0 + 4.0 * w;
  return clamp(num / den, 0.0, 1.0);
}

vec4 sampleFrame(sampler2D tex, vec2 uv, vec2 px, vec2 gx, vec2 gy, bool magnifying) {
  if (!magnifying) return textureGrad(tex, uv, gx, gy); // explicit gradients: safe inside a per-pixel branch
  vec4 c = bicubic(tex, px);
  if (u_soft > 0.0) c = mix(c, bicubicLod(tex, px, 1), u_soft);
  if (u_sharpen > 0.0 && c.a > 0.001) {
    // Un-premultiply alpha so contrast-adaptive math operates in true linear color space
    vec3 straight = c.rgb / c.a;
    vec3 sharpened = casSharpen(tex, px, straight, u_sharpen);
    c.rgb = sharpened * c.a;
  }
  return c;
}

// 0 outside a box, rising to 1 over \`feather\` (map units) inside its edge
float edgeMask(vec2 p, vec4 box, float feather) {
  vec2 lo = min(box.xy, box.zw);
  vec2 hi = max(box.xy, box.zw);
  vec2 d = min(p - lo, hi - p);
  return smoothstep(0.0, feather, min(d.x, d.y));
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
  if (u_feather > 0.0) c *= edgeMask(v_merc, u_box, u_feather);
  if (u_holeFeather > 0.0) c *= 1.0 - edgeMask(v_merc, u_hole, u_holeFeather);
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

export interface SatelliteLayerOptions {
  /** The layer's id on the map (a window over the main picture needs its own). */
  id?: string;
  /** Fraction of the picture's width over which its edge fades out (0: only the short fade of the main picture). */
  featherFraction?: number;
}

/** MapLibre custom layer drawing the Meteosat picture with smooth magnification and a GPU cross-fade between two pictures. */
export class SatelliteImageLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly slots = new Map<string, Slot>();
  private frames: readonly (SatelliteLayerFrame | null)[] = [];
  private bounds: GeoBounds = SATELLITE_BOUNDS;
  private position = 0;
  private opacity = 0.9;
  private look: 'picture' | 'clouds' | 'thermal' = 'clouds';
  private lite = false;
  private readonly featherFraction: number;
  /** A closer window drawn over this picture: this picture makes room for it while it can be drawn. */
  private window: SatelliteImageLayer | null = null;

  constructor(options: SatelliteLayerOptions = {}) {
    this.id = options.id ?? 'satellite-image-layer';
    this.featherFraction = options.featherFraction ?? 0;
  }

  /** The pictures of the loop, oldest first (null: not there yet). Pictures no longer listed are released. */
  setFrames(frames: readonly (SatelliteLayerFrame | null)[]): void {
    this.frames = [...frames];
    const keep = new Set<string>();
    for (const f of frames) if (f) keep.add(f.key);
    for (const [key, slot] of this.slots) {
      if (keep.has(key)) continue;
      slot.bitmap?.close();
      if (slot.texture && this.gl) this.gl.deleteTexture(slot.texture);
      this.slots.delete(key);
    }
    for (const f of frames) if (f && !this.slots.has(f.key)) void this.load(f);
    this.map?.triggerRepaint();
  }

  /** The ground the pictures cover (all of India unless this is a closer window). */
  setBounds(bounds: GeoBounds): void {
    if (bounds === this.bounds) return;
    this.bounds = bounds;
    this.writeQuad();
    this.map?.triggerRepaint();
  }

  /** The closer window to make room for (null: none). */
  setWindow(window: SatelliteImageLayer | null): void {
    this.window = window;
    this.map?.triggerRepaint();
  }

  /**
   * What is being shown. The full picture is the satellite's own image, so it only gets a gentle lift (smooth bicubic
   * magnification and mild sharpening). The cloud-only view is smoothed (and its texture restored) when the cloud is picked,
   * so it gets no sharpening on top.
   */
  setLook(look: 'picture' | 'clouds' | 'thermal'): void {
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

  /** True when the picture for the loop's position has arrived, so this layer would draw something now. */
  canDraw(): boolean {
    const n = this.frames.length;
    if (n === 0 || this.opacity <= 0.001) return false;
    const frame = this.frames[Math.min(Math.max(Math.floor(this.position), 0), n - 1)];
    const slot = frame ? this.slots.get(frame.key) : undefined;
    return !!slot && (slot.texture !== null || slot.bitmap !== null);
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
    for (const name of ['u_matrix', 'u_a', 'u_b', 'u_box', 'u_size', 'u_mixB', 'u_opacity', 'u_sharpen', 'u_soft', 'u_hasB', 'u_wide', 'u_feather', 'u_hole', 'u_holeFeather']) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    this.writeQuad();
    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    // textures already loaded for an earlier GL context are re-uploaded
    for (const slot of this.slots.values()) slot.texture = null;
  }

  /** The four corners of the picture's box in the vertex buffer (the fragment shader cuts the picture out by its own box). */
  private writeQuad(): void {
    const gl = this.gl;
    if (!gl || !this.vbo) return;
    const b = this.bounds;
    const x0 = mercatorUnitX(b.west);
    const x1 = mercatorUnitX(b.east);
    const y0 = mercatorUnitY(b.north);
    const y1 = mercatorUnitY(b.south);
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

  /** The box (map units) and feather of this layer, for the picture underneath to make room: null when it cannot draw yet. */
  windowBox(): { box: [number, number, number, number]; feather: number } | null {
    if (this.featherFraction <= 0 || !this.canDraw()) return null;
    const b = this.bounds;
    const x0 = mercatorUnitX(b.west);
    const x1 = mercatorUnitX(b.east);
    const y0 = mercatorUnitY(b.north);
    const y1 = mercatorUnitY(b.south);
    return { box: [x0, y0, x1, y1], feather: this.featherFraction * Math.abs(x1 - x0) };
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const program = this.program;
    const n = this.frames.length;
    if (!program || n === 0 || this.opacity <= 0.001) return;
    const base = Math.min(Math.max(Math.floor(this.position), 0), n - 1);
    const frac = Math.min(Math.max(this.position - base, 0), 1);
    const frameA = this.frames[base];
    if (!frameA) return;
    const a = this.textureOf(gl, frameA);
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
    const bounds = this.bounds;
    gl.uniformMatrix4fv(u['u_matrix'], false, options.defaultProjectionData.mainMatrix as unknown as Float32List);
    gl.uniform1i(u['u_a'], 0);
    gl.uniform1i(u['u_b'], 1);
    gl.uniform4f(u['u_box'], mercatorUnitX(bounds.west), mercatorUnitY(bounds.north), mercatorUnitX(bounds.east), mercatorUnitY(bounds.south));
    gl.uniform2i(u['u_size'], a.w, a.h);
    gl.uniform1f(u['u_mixB'], b ? frac : 0);
    gl.uniform1f(u['u_opacity'], this.opacity);
    gl.uniform1f(u['u_sharpen'], this.look === 'clouds' ? 0.35 : (this.lite ? 0.45 : 0.65));
    gl.uniform1f(u['u_soft'], 0);
    gl.uniform1i(u['u_hasB'], b ? 1 : 0);
    gl.uniform1f(u['u_wide'], 0);
    gl.uniform1f(u['u_feather'], this.featherFraction > 0 ? this.featherFraction * Math.abs(mercatorUnitX(bounds.east) - mercatorUnitX(bounds.west)) : 0);
    const hole = this.window?.windowBox() ?? null;
    if (hole) gl.uniform4f(u['u_hole'], hole.box[0], hole.box[1], hole.box[2], hole.box[3]);
    gl.uniform1f(u['u_holeFeather'], hole ? hole.feather : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
