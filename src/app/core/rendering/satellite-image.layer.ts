import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { mercatorUnitX, mercatorUnitY } from '../forecast/forecast.model';
import { GeoBounds, SATELLITE_BOUNDS } from '../satellite/satellite.config';
import type { FlowField } from '../satellite/satellite-flow';
import { PendingProgram } from './gl-program';

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
 * (Catmull-Rom) filter, with a small softening of colour and of the cloud's edge (opacity), so the picture's pixels and the
 * staircase of a cloud's boundary do not show. (AMD FidelityFX CAS sharpening was tried and removed: it added almost nothing
 * at this magnification.)
 *
 * Pictures are stored as straight RGBA and premultiplied in the shader (in float), so cloud edges (transparent land and sea) blend
 * without dark or bright fringes and faint cloud keeps its exact colour.
 *
 * A closer window of the same picture can sit over the whole-India one (see satellite-window.ts): the window fades out over a
 * feather at its edge (`u_feather`, in map units) and the whole-India layer, told where the window is, fades out inside it by the
 * same amount (`u_hole`), so the two always add up to one picture and the window shows no frame.
 *
 * Between two pictures of the loop the clouds move rather than fade (satellite-flow.ts): with the motion from A to B (`u_flow`, worked out
 * on the whole-India picture, so both layers read it by map position), the in-between time t takes A from t of the way back along the
 * motion and B from the rest of the way forward. At t = 0 and 1 each picture is drawn exactly as it is.
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
uniform int u_hasB;
uniform float u_feather;   // > 0: fade the picture out over this much (map units) inside its own edge (a window over the main picture)
uniform vec4 u_hole;       // mercator box of a window drawn over this picture, which this picture fades out inside
uniform float u_holeFeather; // > 0 when there is a window to make room for
uniform sampler2D u_flow;   // RG: the cloud motion from A to B, as fractions of the whole-India picture (u_flowBox)
uniform int u_hasFlow;
uniform vec4 u_flowBox;     // mercator x0, y0, x1, y1 of the whole-India picture the motion was worked out on
uniform vec4 u_flowNodes;   // the first node and the node spacing, as fractions of that picture
uniform vec2 u_flowCount;   // nodes across and down
in vec2 v_merc;
out vec4 outColor;

vec4 weights(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}

// The pictures are stored with straight (not premultiplied) colour, so that faint cloud keeps its exact colour; every filter below
// works on premultiplied values.
vec4 premultiplied(vec4 c) {
  return vec4(c.rgb * c.a, c.a);
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
      sum += premultiplied(texelFetch(tex, q, 0)) * (wx[i] * wy[j]);
    }
  }
  return clamp(sum, 0.0, 1.0);
}

// The mean of the picture (bilinear) at four diagonal points r picture pixels from px: a small, even blur.
vec4 around(sampler2D tex, vec2 px, float r) {
  vec2 inv = 1.0 / vec2(u_size);
  return 0.25 * (premultiplied(textureLod(tex, (px + vec2(r, r)) * inv, 0.0)) + premultiplied(textureLod(tex, (px + vec2(-r, r)) * inv, 0.0))
               + premultiplied(textureLod(tex, (px + vec2(r, -r)) * inv, 0.0)) + premultiplied(textureLod(tex, (px + vec2(-r, -r)) * inv, 0.0)));
}

// Magnified: the colour is softened a little (so the picture's pixels do not show as blocks), and then the
// cloud's edge (its opacity) is softened, so the boundary of a cloud is a smooth curve, not a staircase. Colour stays premultiplied
// and never exceeds the opacity.
vec4 sampleFrame(sampler2D tex, vec2 uv, vec2 px, vec2 gx, vec2 gy, bool magnifying) {
  if (!magnifying) return premultiplied(textureGrad(tex, uv, gx, gy)); // explicit gradients: safe inside a per-pixel branch
  vec4 c = bicubic(tex, px);
  if (c.a <= 0.001 && around(tex, px, 1.0).a <= 0.001) return c; // clear ground, well away from any cloud
  c.rgb = mix(c.rgb, around(tex, px, 0.4).rgb, 0.5);
  c.a = clamp(mix(c.a, around(tex, px, 0.5).a, 0.6), 0.0, 1.0);
  c.rgb = min(c.rgb, vec3(c.a));
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

  vec2 uvA = uv;
  vec2 uvB = uv;
  if (u_hasB == 1 && u_hasFlow == 1) {
    // the motion at this map position, in map units, then each picture taken from where its clouds are at this moment
    vec2 span = u_flowBox.zw - u_flowBox.xy;
    vec2 f = (v_merc - u_flowBox.xy) / span;
    vec2 node = (f - u_flowNodes.xy) / u_flowNodes.zw;
    vec2 motion = texture(u_flow, (node + 0.5) / u_flowCount).rg * span;
    vec2 own = u_box.zw - u_box.xy;
    uvA = uv - u_mixB * motion / own;
    uvB = uv + (1.0 - u_mixB) * motion / own;
  }
  vec4 c = sampleFrame(u_a, uvA, uvA * vec2(u_size), gx, gy, magnifying);
  if (u_hasB == 1) {
    vec4 b = sampleFrame(u_b, uvB, uvB * vec2(u_size), gx, gy, magnifying);
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
  private pending: PendingProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly slots = new Map<string, Slot>();
  private frames: readonly (SatelliteLayerFrame | null)[] = [];
  private bounds: GeoBounds = SATELLITE_BOUNDS;
  private position = 0;
  private opacity = 0.9;
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
   * The cloud motion from each frame to the next (null: none known, plain cross-fade), worked out on the whole-India picture over
   * `over` (its bounds), so a closer window reads the same motion by map position.
   */
  setFlows(flows: readonly (FlowField | null)[], over: GeoBounds = SATELLITE_BOUNDS): void {
    if (flows === this.flows && over === this.flowBounds) return;
    this.flows = flows;
    this.flowBounds = over;
    this.map?.triggerRepaint();
  }

  private flows: readonly (FlowField | null)[] = [];
  private flowBounds: GeoBounds = SATELLITE_BOUNDS;
  private readonly flowTextures = new WeakMap<FlowField, WebGLTexture>();

  /** The motion's texture, uploaded on first use (two 16-bit floats a node, filtered linearly). */
  private flowTexture(gl: WebGL2RenderingContext, field: FlowField): WebGLTexture {
    let tex = this.flowTextures.get(field);
    if (!tex) {
      tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, field.cols, field.rows, 0, gl.RG, gl.FLOAT, field.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.flowTextures.set(field, tex);
    }
    return tex;
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
    if (!this.program && !this.pending?.ready()) return false; // its shader is still compiling: the picture under it must not make room yet
    const frame = this.frames[Math.min(Math.max(Math.floor(this.position), 0), n - 1)];
    const slot = frame ? this.slots.get(frame.key) : undefined;
    return !!slot && (slot.texture !== null || slot.bitmap !== null);
  }

  private async load(frame: SatelliteLayerFrame): Promise<void> {
    const slot: Slot = { bitmap: null, texture: null, failed: false };
    this.slots.set(frame.key, slot);
    try {
      const blob = await (await fetch(frame.url)).blob();
      // straight colour (premultiplied by the shader in full precision): 8-bit premultiplied storage bands the colour of faint cloud
      const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
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
    // compiled in the background (see gl-program.ts); drawing starts on the first frame it is ready
    this.pending = new PendingProgram(gl, VERTEX, FRAGMENT, 'satellite');
    this.program = null;
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    this.writeQuad();
    const loc = 0; // a_pos, bound to 0 before the link (gl-program.ts)
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
    const handle = this.program ?? this.pending?.handle;
    if (handle) gl.deleteProgram(handle);
    this.pending = null;
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

  /** The program once the driver has it ready, with its uniforms looked up (false while it is still compiling: another frame is asked for). */
  private takeProgram(gl: WebGL2RenderingContext): boolean {
    const program = this.pending?.ready();
    if (!program) {
      if (this.pending) this.map?.triggerRepaint();
      return false;
    }
    this.program = program;
    for (const name of ['u_matrix', 'u_a', 'u_b', 'u_box', 'u_size', 'u_mixB', 'u_opacity', 'u_hasB', 'u_feather', 'u_hole', 'u_holeFeather',
      'u_flow', 'u_hasFlow', 'u_flowBox', 'u_flowNodes', 'u_flowCount']) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    return true;
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.program && !this.takeProgram(gl)) return;
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
    gl.uniform1i(u['u_hasB'], b ? 1 : 0);
    gl.uniform1f(u['u_feather'], this.featherFraction > 0 ? this.featherFraction * Math.abs(mercatorUnitX(bounds.east) - mercatorUnitX(bounds.west)) : 0);
    const hole = this.window?.windowBox() ?? null;
    if (hole) gl.uniform4f(u['u_hole'], hole.box[0], hole.box[1], hole.box[2], hole.box[3]);
    gl.uniform1f(u['u_holeFeather'], hole ? hole.feather : 0);
    const field = b ? this.flows[base] ?? null : null;
    gl.uniform1i(u['u_hasFlow'], field ? 1 : 0);
    gl.activeTexture(gl.TEXTURE2);
    if (field) {
      gl.bindTexture(gl.TEXTURE_2D, this.flowTexture(gl, field));
      const fb = this.flowBounds;
      gl.uniform4f(u['u_flowBox'], mercatorUnitX(fb.west), mercatorUnitY(fb.north), mercatorUnitX(fb.east), mercatorUnitY(fb.south));
      gl.uniform4f(u['u_flowNodes'], field.x0, field.y0, field.stepX, field.stepY);
      gl.uniform2f(u['u_flowCount'], field.cols, field.rows);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, a.texture); // a sampler must always have a texture bound
    }
    gl.uniform1i(u['u_flow'], 2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
