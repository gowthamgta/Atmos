import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { mercatorUnitX, mercatorUnitY } from '../forecast/forecast.model';
import { FIELD_KM_SCALE, FIELD_TAU_MAX, CloudField } from '../satellite/cloud-field';
import type { FlowField } from '../satellite/satellite-flow';
import { SATELLITE_BOUNDS, sunElevationDeg } from '../satellite/satellite.config';
import { windyInfraredTable } from '../satellite/satellite-image';
import { PendingProgram } from './gl-program';

/**
 * The live satellite clouds in 3D: each frame's cloud field (cloud-field.ts: cover, top and base heights, optical thickness, from the
 * infrared and visible pictures) is drawn as cloud volumes standing over the map at their heights, lit by the sun of the frame's time.
 *
 * Rendering: the view's rays are marched through the slab of air from the ground to 17.5 km (times the height scale), in kilometres around
 * the map's centre. At each step the cloud's density is its cover shaped by where the point is between the cloud's base and top (flat
 * bases, rounded tops), broken into billows by a tiling 3D noise (the satellite sees 2-6 km cells; the noise adds the cloud's own
 * texture at the scale of a few kilometres, so it is invented detail, not measured), and its extinction is the optical thickness spread
 * over the cloud's depth. Light: the sun's light reaching the point through the cloud above it (a short march toward the sun) in three
 * octaves of multiple scattering, plus skylight, which is what makes sunlit tops white and the bases of thick cloud grey. Where a ray
 * reaches the ground, the cloud's shadow is drawn on the map. Between two frames the clouds move along the loop's motion (satellite-flow)
 * as in the flat picture.
 *
 * The march runs at a fraction of the screen's resolution into a texture (prerender) and is scaled up onto the map (render): clouds are
 * soft, and a phone could not march every pixel.
 */

const FULLSCREEN_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

/** Tiling noise for the cloud's texture, made on the GPU slice by slice: R Perlin-Worley (billows), G Worley (detail that erodes edges). */
const NOISE_FS = `#version 300 es
precision highp float;
uniform float u_z;
in vec2 v_uv;
out vec4 o;
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float worley(vec3 p, float f) {
  vec3 q = p * f, id = floor(q), fr = fract(q);
  float d = 9.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    vec3 c = vec3(x, y, z);
    vec3 r = c + hash33(mod(id + c, f)) - fr;
    d = min(d, dot(r, r));
  }
  return 1.0 - clamp(sqrt(d), 0.0, 1.0);
}
float g3(vec3 cell, vec3 r, float f) { vec3 g = normalize(hash33(mod(cell, f)) * 2.0 - 1.0); return dot(g, r); }
float perlin(vec3 p, float f) {
  vec3 q = p * f, i = floor(q), fr = fract(q);
  vec3 u = fr * fr * fr * (fr * (fr * 6.0 - 15.0) + 10.0);
  float a = g3(i, fr, f), b = g3(i + vec3(1,0,0), fr - vec3(1,0,0), f);
  float c = g3(i + vec3(0,1,0), fr - vec3(0,1,0), f), d = g3(i + vec3(1,1,0), fr - vec3(1,1,0), f);
  float e = g3(i + vec3(0,0,1), fr - vec3(0,0,1), f), ff = g3(i + vec3(1,0,1), fr - vec3(1,0,1), f);
  float g = g3(i + vec3(0,1,1), fr - vec3(0,1,1), f), h = g3(i + vec3(1,1,1), fr - vec3(1,1,1), f);
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, ff, u.x), mix(g, h, u.x), u.y), u.z);
}
void main() {
  vec3 p = vec3(v_uv, u_z);
  float pf = clamp((perlin(p, 4.0) * 0.5 + perlin(p, 8.0) * 0.25 + perlin(p, 16.0) * 0.125) * 0.9 + 0.5, 0.0, 1.0);
  float w1 = worley(p, 4.0) * 0.625 + worley(p, 8.0) * 0.25 + worley(p, 16.0) * 0.125;
  float w2 = worley(p, 8.0) * 0.625 + worley(p, 16.0) * 0.25 + worley(p, 32.0) * 0.125;
  float pw = clamp((pf - (1.0 - w1)) / (1.0 - (1.0 - w1) * 0.6), 0.0, 1.0);
  o = vec4(clamp(mix(pf, pw, 0.6), 0.0, 1.0), w2, 0.0, 1.0);
}`;

const MARCH_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler3D u_noise;
uniform sampler2D u_flow;
uniform int u_hasB;
uniform int u_hasFlow;
uniform float u_mixB;
uniform vec4 u_flowNodes;
uniform vec2 u_flowCount;
uniform vec3 u_near[4];     // the view's corners on the near plane (km around the map's centre: east, north, up): bl, br, tl, tr
uniform vec3 u_far[4];
uniform vec2 u_uvOrigin;    // the field's texture position of the map's centre
uniform vec2 u_uvPerKm;     // and its change per km east and north
uniform vec3 u_sun;         // toward the light (east, north, up)
uniform vec3 u_sunColor;
uniform vec3 u_skyColor;
uniform float u_exag;       // the height scale
uniform float u_steps;
uniform float u_shadow;     // how dark a cloud's shadow on the map is
uniform sampler2D u_detA;   // the frame's own picture (Mercator, over the field's box): its visible brightness shapes the clouds
uniform sampler2D u_detB;
uniform float u_hasDet;
uniform sampler2D u_irA;    // the frame's infrared (its data pack: red = 10.8 um, K = 180 + v x 140), as the flat Infrared draws it
uniform sampler2D u_irB;
uniform sampler2D u_lut;    // Windy's infrared colours over 180..320 K (satellite-image.ts windyInfraredTable)
uniform float u_hasIr;      // 1: colour the clouds by the infrared
uniform vec4 u_irAff;       // the field's uv -> the data pack's uv: scale x, y, offset x, y
in vec2 v_uv;
out vec4 o;

const float KM = ${FIELD_KM_SCALE.toFixed(1)};
const float TAU_MAX = ${FIELD_TAU_MAX.toFixed(1)};

float sat(float v) { return clamp(v, 0.0, 1.0); }
float remap(float v, float a, float b, float c, float d) { return c + (v - a) / max(b - a, 1e-4) * (d - c); }
float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }

// the picture's brightness at a place (0..1, the visible channel of the frame's own picture), moved as the column is
float detailAt(vec2 uvA, vec2 uvB) {
  // read a little blurred (a coarser mip level): the cloud takes the picture's shapes, not its pixel grain
  float a = texture(u_detA, uvA, 1.5).r;
  return u_hasB == 1 ? mix(a, texture(u_detB, uvB, 1.5).r, u_mixB) : a;
}

float g_det = 0.0;   // the picture's brightness where column() last looked
vec2 g_uvA = vec2(0.0);   // and where it looked in each of the two frames
vec2 g_uvB = vec2(0.0);

// the cloud's colour from the infrared at a place, as the flat Infrared colours it (white where there is no infrared)
vec3 irColour(vec2 uvA, vec2 uvB) {
  vec2 a = uvA * u_irAff.xy + u_irAff.zw;
  vec2 b = uvB * u_irAff.xy + u_irAff.zw;
  float v = texture(u_irA, a, 1.0).r;   // a little smoothed: the 3 km temperatures are noisy over low cloud
  if (u_hasB == 1) v = mix(v, texture(u_irB, b, 1.0).r, u_mixB);
  if (v <= 0.5 / 255.0) return vec3(1.0);
  vec4 c = texture(u_lut, vec2(v, 0.5));
  // the infrared's greys (warm low cloud) are lifted, so a low cloud stays a lit cloud and not a dark lump; its colours are kept
  vec3 col = mix(vec3(1.0), c.rgb, c.a);
  float chroma = max(col.r, max(col.g, col.b)) - min(col.r, min(col.g, col.b));
  return chroma < 0.12 ? vec3(0.95) : col;   // warm low cloud a plain soft white, not mottled grey
}

// the cloud column at a map position (cover, top km, base km, optical thickness), moved along the loop's motion between two frames
vec4 column(vec2 uv) {
  vec2 uvA = uv;
  vec2 uvB = uv;
  if (u_hasB == 1 && u_hasFlow == 1) {
    vec2 node = (uv - u_flowNodes.xy) / u_flowNodes.zw;
    vec2 motion = texture(u_flow, (node + 0.5) / u_flowCount).rg;
    uvA = uv - u_mixB * motion;
    uvB = uv + (1.0 - u_mixB) * motion;
  }
  vec4 f = texture(u_a, uvA);
  if (u_hasB == 1) f = mix(f, texture(u_b, uvB), u_mixB);
  g_det = u_hasDet > 0.5 ? detailAt(uvA, uvB) : 0.5;
  g_uvA = uvA;
  g_uvB = uvB;
  return vec4(f.r, f.g * KM, f.b * KM, f.a * f.a * TAU_MAX);
}

// density (0..1) and extinction (1/km) at a point (km; height already divided by the height scale in p.z)
vec2 cloudAt(vec3 p) {
  vec2 uv = u_uvOrigin + p.xy * u_uvPerKm;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(0.0);
  vec4 c = column(uv);
  float z = p.z;
  if (c.r < 0.03 || z > c.g + 0.25 || z < c.b - 0.25) return vec2(0.0);
  float thick = max(c.g - c.b, 0.3);
  float h = (z - c.b) / thick;
  bool cirrus = c.b > 6.0 && c.a < 10.0;
  // flat base, rounded top for heaped cloud; a soft layer for thin high cloud
  float prof = cirrus ? smoothstep(-0.1, 0.3, h) * (1.0 - smoothstep(0.6, 1.05, h)) : smoothstep(-0.03, 0.1, h) * (1.0 - smoothstep(0.7, 1.02, h));
  // the shape comes from the satellite's own picture (1.25 km): where it is bright there is cloud, its gaps are holes, its texture the
  // billows; the noise only adds the small detail the picture cannot show, warped so it never repeats in a visible pattern
  // soft rounded puffs a few km across (the noise's billowy channel only: no fine erosion, which made the surface look like foam)
  vec3 q = cirrus ? vec3(p.x * 0.008, p.y * 0.025, z * 0.12) : vec3(p.xy * 0.032, z * 0.06);
  q.xy += (texture(u_noise, q * 0.31 + 0.17).gb - 0.5) * 0.35;
  vec4 n = texture(u_noise, q);
  float pic = smoothstep(0.25, 0.8, g_det);
  float shape = mix(n.r, pic * (0.8 + 0.2 * n.r), u_hasDet * 0.8);
  float coverage = c.r * prof;
  // a soft edge: density rises gently from the cloud's rim, so its outline is wispy rather than a hard crust
  float d = smoothstep(0.0, 0.55, remap(shape, 1.0 - coverage, 1.0, 0.0, 1.0));
  float sigma = clamp(c.a / thick, 0.05, 60.0);
  return vec2(d, sigma);
}

float phaseHG(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

// the optical depth from a point toward the light (the path stretched with the heights, as the clouds are)
float sunTau(vec3 p, vec3 sunS) {
  float tau = 0.0;
  float step = 0.25;   // starts small: a cloud's own billows shade one another
  vec3 x = p;
  for (int i = 0; i < 4; i++) {
    x += sunS * step;
    vec2 c = cloudAt(vec3(x.xy, x.z / u_exag));
    tau += c.x * c.y * step;
    step *= 2.2;
  }
  return tau;
}

void main() {
  vec3 ro = mix(mix(u_near[0], u_near[1], v_uv.x), mix(u_near[2], u_near[3], v_uv.x), v_uv.y);
  vec3 rf = mix(mix(u_far[0], u_far[1], v_uv.x), mix(u_far[2], u_far[3], v_uv.x), v_uv.y);
  vec3 rd = normalize(rf - ro);
  float zTop = 17.5 * u_exag;   // above the highest tropical tops
  // the slab of air from the ground to the top
  float tA = 0.0;
  float tB = 1e6;
  if (abs(rd.z) > 1e-5) {
    float t0 = (0.0 - ro.z) / rd.z;
    float t1 = (zTop - ro.z) / rd.z;
    tA = max(min(t0, t1), 0.0);
    tB = max(t0, t1);
  } else if (ro.z < 0.0 || ro.z > zTop) {
    o = vec4(0.0);
    return;
  }
  float tGround = rd.z < 0.0 ? -ro.z / rd.z : -1.0;
  tB = min(tB, tA + 500.0);
  vec3 sunS = normalize(vec3(u_sun.xy, u_sun.z * u_exag));
  float mu = dot(rd, u_sun);
  float ph0 = mix(phaseHG(mu, 0.6), phaseHG(mu, -0.2), 0.25) * 12.566;
  float ph1 = mix(phaseHG(mu, 0.3), phaseHG(mu, -0.1), 0.25) * 12.566;
  float ph2 = mix(phaseHG(mu, 0.15), phaseHG(mu, -0.05), 0.25) * 12.566;
  float dtBase = max((tB - tA) / u_steps, 0.12);
  float T = 1.0;
  vec3 L = vec3(0.0);
  float t = tA + hash12(gl_FragCoord.xy) * dtBase;
  int steps = int(u_steps) * 2;
  for (int i = 0; i < 256; i++) {
    if (i >= steps || t > tB || T < 0.02) break;
    vec3 p = ro + rd * t;
    vec2 c = cloudAt(vec3(p.xy, p.z / u_exag));
    // what cloudAt found here, kept before the march toward the sun looks elsewhere
    float det = g_det;
    vec2 hereA = g_uvA;
    vec2 hereB = g_uvB;
    float dt = dtBase;
    if (c.x > 0.002) {
      dt *= 0.5;
      float sigma = c.x * c.y / sqrt(u_exag);   // a stretched cloud is not made thicker to light
      float tau = sunTau(p, sunS);
      vec3 lum = u_sunColor * (exp(-tau) * ph0 + 0.5 * exp(-0.3 * tau) * ph1 + 0.25 * exp(-0.1 * tau) * ph2) * 0.6
        + u_skyColor * (0.35 + 0.65 * exp(-0.05 * tau)) * (0.6 + 0.4 * sat(p.z / (12.0 * u_exag)));
      // the light and shade the satellite itself saw on these tops (its brightness here): the real texture of the cloud's surface
      if (u_hasDet > 0.5) lum *= mix(0.45, 1.1, smoothstep(0.2, 0.9, det));
      if (u_hasIr > 0.5) lum *= irColour(hereA, hereB) * 1.1;
      float a = exp(-sigma * dt);
      L += T * lum * (1.0 - a);
      T *= a;
    } else {
      dt *= 1.5;   // clear air: stride
    }
    t += dt;
  }
  float alpha = 1.0 - T;
  vec3 col = alpha > 1e-4 ? L / alpha : vec3(0.0);
  col *= 0.85;
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);   // filmic tone map
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  vec4 res = vec4(col * alpha, alpha);
  // the clouds' shadow on the map where the ray reaches the ground
  if (tGround > 0.0 && T > 0.02 && u_shadow > 0.0) {
    vec3 g = ro + rd * tGround;
    float tau = 0.0;
    float step = 0.6;
    vec3 x = g;
    for (int i = 0; i < 6; i++) {
      x += sunS * step;
      if (x.z > zTop) break;
      vec2 c = cloudAt(vec3(x.xy, x.z / u_exag));
      tau += c.x * c.y * step / sqrt(u_exag);
      step *= 1.8;
    }
    float s = (1.0 - exp(-tau)) * u_shadow * T;
    res = res + vec4(0.0, 0.0, 0.0, s) * (1.0 - res.a);
  }
  o = res;
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_opacity;
in vec2 v_uv;
out vec4 o;
// the march's dither smoothed away as it is scaled up: a small tent of five taps one low-resolution pixel apart
void main() {
  vec2 px = 1.0 / vec2(textureSize(u_tex, 0));
  vec4 c = texture(u_tex, v_uv) * 0.4
    + (texture(u_tex, v_uv + vec2(px.x, 0.0)) + texture(u_tex, v_uv - vec2(px.x, 0.0))
     + texture(u_tex, v_uv + vec2(0.0, px.y)) + texture(u_tex, v_uv - vec2(0.0, px.y))) * 0.15;
  o = c * u_opacity;
}`;

export interface CloudVolumeFrame {
  key: string;
  field: CloudField | null;
  timeMs: number;
  /** The frame's own picture (an image address; Mercator over the field's box), whose brightness shapes the clouds. */
  picture?: string;
  /** The frame's infrared (its data pack: an image address, and the Mercator box it covers), for the infrared colouring. */
  ir?: { url: string; bounds: { west: number; east: number; south: number; north: number } };
}

/** The noise texture's size (a cube); made a few slices a frame. */
const NOISE = 64;
const NOISE_SLICES_PER_FRAME = 6;
const EARTH_KM = 40_075.017;

export class CloudVolumeLayer implements CustomLayerInterface {
  readonly id = 'satellite-3d-layer';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private noiseProg: PendingProgram | null = null;
  private marchProg: PendingProgram | null = null;
  private compProg: PendingProgram | null = null;
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private noise: WebGLTexture | null = null;
  private noiseDone = 0;
  private fbo: WebGLFramebuffer | null = null;
  private target: WebGLTexture | null = null;
  private targetSize: [number, number] = [0, 0];
  private drewTarget = false;
  private readonly fieldTextures = new WeakMap<CloudField, WebGLTexture>();
  private readonly flowTextures = new WeakMap<FlowField, WebGLTexture>();
  private frames: readonly CloudVolumeFrame[] = [];
  private flows: readonly (FlowField | null)[] = [];
  private position = 0;
  private opacity = 1;
  private exag = 3;
  private readonly phone: boolean;

  constructor() {
    this.phone = typeof window !== 'undefined' && Math.min(window.innerWidth, window.innerHeight) < 700;
  }

  setFrames(frames: readonly CloudVolumeFrame[]): void {
    this.frames = frames;
    const keep = new Set(frames.flatMap(f => [f.picture, f.ir?.url]).filter(Boolean));
    for (const [url, t] of this.pictures) {
      if (keep.has(url)) continue;
      t.bitmap?.close();
      if (t.texture && this.gl) this.gl.deleteTexture(t.texture);
      this.pictures.delete(url);
    }
    for (const f of frames) {
      if (f.picture && !this.pictures.has(f.picture)) void this.loadPicture(f.picture);
      if (f.ir && !this.pictures.has(f.ir.url)) void this.loadPicture(f.ir.url);
    }
    this.map?.triggerRepaint();
  }

  private readonly pictures = new Map<string, { bitmap: ImageBitmap | null; texture: WebGLTexture | null }>();

  private async loadPicture(url: string): Promise<void> {
    const slot = { bitmap: null as ImageBitmap | null, texture: null as WebGLTexture | null };
    this.pictures.set(url, slot);
    try {
      const blob = await (await fetch(url)).blob();
      const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      if (this.pictures.get(url) !== slot) return bitmap.close();
      slot.bitmap = bitmap;
      this.map?.triggerRepaint();
    } catch {
      this.pictures.delete(url);
    }
  }

  /** The picture's texture (with mipmaps: seen from afar it is read averaged), uploaded on first use. */
  private pictureTexture(gl: WebGL2RenderingContext, url: string | undefined): WebGLTexture | null {
    const slot = url ? this.pictures.get(url) : undefined;
    if (!slot) return null;
    if (!slot.texture && slot.bitmap) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
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
    }
    return slot.texture;
  }

  setFlows(flows: readonly (FlowField | null)[]): void {
    this.flows = flows;
    this.map?.triggerRepaint();
  }

  setPosition(position: number, opacity: number): void {
    this.position = position;
    this.opacity = opacity;
    this.map?.triggerRepaint();
  }

  /** Colour the clouds by the infrared (true) or keep them white. */
  setIrColour(on: boolean): void {
    this.irColour = on;
    this.map?.triggerRepaint();
  }

  private irColour = true;
  private lut: WebGLTexture | null = null;

  private lutTexture(gl: WebGL2RenderingContext): WebGLTexture {
    if (!this.lut) {
      this.lut = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.lut);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, windyInfraredTable(180, 140, 256));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    return this.lut;
  }

  setHeightScale(scale: number): void {
    this.exag = scale;
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    this.noiseProg = new PendingProgram(gl, FULLSCREEN_VS, NOISE_FS, 'cloud noise');
    this.marchProg = new PendingProgram(gl, FULLSCREEN_VS, MARCH_FS, 'cloud volume');
    this.compProg = new PendingProgram(gl, FULLSCREEN_VS, COMPOSITE_FS, 'cloud composite');
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.noise = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.noise);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, NOISE, NOISE, NOISE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.REPEAT],
      [gl.TEXTURE_WRAP_T, gl.REPEAT], [gl.TEXTURE_WRAP_R, gl.REPEAT]] as const) {
      gl.texParameteri(gl.TEXTURE_3D, k, v);
    }
    this.noiseDone = 0;
    this.fbo = gl.createFramebuffer();
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    for (const t of this.pictures.values()) {
      t.bitmap?.close();
      if (t.texture) gl.deleteTexture(t.texture);
    }
    this.pictures.clear();
    if (this.lut) gl.deleteTexture(this.lut);
    this.lut = null;
    for (const p of [this.noiseProg, this.marchProg, this.compProg]) if (p?.handle) gl.deleteProgram(p.handle);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.noise) gl.deleteTexture(this.noise);
    if (this.target) gl.deleteTexture(this.target);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    this.noiseProg = this.marchProg = this.compProg = null;
    this.vbo = this.vao = this.noise = this.target = this.fbo = null;
    this.targetSize = [0, 0];
    this.map = null;
    this.gl = null;
  }

  private uniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.uniforms.get(program);
    if (!m) this.uniforms.set(program, (m = new Map()));
    if (!m.has(name)) m.set(name, gl.getUniformLocation(program, name));
    return m.get(name)!;
  }

  /** A few slices of the noise each frame (all at once would hold up the page while the GPU works through them). */
  private makeNoise(gl: WebGL2RenderingContext, program: WebGLProgram): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, NOISE, NOISE);
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    const uz = this.uniform(gl, program, 'u_z');
    const end = Math.min(NOISE, this.noiseDone + NOISE_SLICES_PER_FRAME);
    for (let z = this.noiseDone; z < end; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.noise, 0, z);
      gl.uniform1f(uz, (z + 0.5) / NOISE);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    this.noiseDone = end;
    gl.bindVertexArray(null);
  }

  private fieldTexture(gl: WebGL2RenderingContext, field: CloudField): WebGLTexture {
    let tex = this.fieldTextures.get(field);
    if (!tex) {
      tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, field.w, field.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, field.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.fieldTextures.set(field, tex);
    }
    return tex;
  }

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

  private ensureTarget(gl: WebGL2RenderingContext, w: number, h: number): void {
    if (this.target && this.targetSize[0] === w && this.targetSize[1] === h) return;
    if (this.target) gl.deleteTexture(this.target);
    this.target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.targetSize = [w, h];
  }

  /** The cloud march into the low-resolution texture. */
  prerender(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    this.drewTarget = false;
    const map = this.map;
    if (!map || !this.noiseProg || !this.marchProg || this.opacity <= 0.001) return;
    const noiseProgram = this.noiseProg.ready();
    const march = this.marchProg.ready();
    if (!noiseProgram || !march) {
      map.triggerRepaint();
      return;
    }
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    if (this.noiseDone < NOISE) {
      this.makeNoise(gl, noiseProgram);
      map.triggerRepaint();
      return;
    }
    const n = this.frames.length;
    if (n === 0) return;
    const base = Math.min(Math.max(Math.floor(this.position), 0), n - 1);
    const frac = Math.min(Math.max(this.position - base, 0), 1);
    const fa = this.frames[base];
    if (!fa?.field) return;
    const fbFrame = frac > 0.001 && base + 1 < n ? this.frames[base + 1] : null;
    const fb = fbFrame?.field ? fbFrame : null;

    const canvas = map.getCanvas();
    const scale = this.phone ? 0.33 : 0.5;
    const w = Math.max(1, Math.round(canvas.width * scale));
    const h = Math.max(1, Math.round(canvas.height * scale));
    this.ensureTarget(gl, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.target, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // the view's rays in km around the map's centre (worked out in double precision here, so the shader's floats stay small)
    const centre = map.getCenter();
    const ox = mercatorUnitX(centre.lng);
    const oy = mercatorUnitY(centre.lat);
    const kmPerUnit = EARTH_KM * Math.cos((centre.lat * Math.PI) / 180);
    const inv = invert(options.defaultProjectionData.mainMatrix as unknown as ArrayLike<number>);
    if (!inv) return;
    const corner = (x: number, y: number, z: number): number[] => {
      const v = transform(inv, [x, y, z, 1]);
      return [(v[0] / v[3] - ox) * kmPerUnit, -(v[1] / v[3] - oy) * kmPerUnit, (v[2] / v[3]) * kmPerUnit];
    };
    const near: number[] = [];
    const far: number[] = [];
    for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      near.push(...corner(x, y, -1));
      far.push(...corner(x, y, 1));
    }
    const b = SATELLITE_BOUNDS;
    const bx0 = mercatorUnitX(b.west);
    const bx1 = mercatorUnitX(b.east);
    const by0 = mercatorUnitY(b.north);
    const by1 = mercatorUnitY(b.south);

    // the light of the frame's time over the map's centre; at night a dim, cool light from high up so the clouds can still be seen
    const time = fa.timeMs + (fb ? frac * (fb.timeMs - fa.timeMs) : 0);
    const sun = sunDirection(time, centre.lat, centre.lng);
    const night = sun[2] < Math.sin((3 * Math.PI) / 180);
    const light = night ? [0.25, -0.35, 0.9] : sun;
    const warm = night ? 0 : Math.min(1, Math.max(0, (sun[2] - 0.05) / 0.4)); // reddened near sunrise and sunset
    const sunColor = night ? [0.42, 0.46, 0.58] : [1.55, 1.55 * (0.8 + 0.17 * warm), 1.55 * (0.6 + 0.35 * warm)];   // sunlit tops near white, shaded sides grey
    const sky = night ? [0.1, 0.12, 0.17] : [0.3, 0.38, 0.52];

    gl.useProgram(march);
    gl.bindVertexArray(this.vao);
    const u = (name: string) => this.uniform(gl, march, name);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTexture(gl, fa.field));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTexture(gl, (fb ?? fa).field!));
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, this.noise);
    const flow = fb ? this.flows[base] ?? null : null;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, flow ? this.flowTexture(gl, flow) : this.fieldTexture(gl, fa.field));
    gl.uniform1i(u('u_a'), 0);
    gl.uniform1i(u('u_b'), 1);
    gl.uniform1i(u('u_noise'), 2);
    gl.uniform1i(u('u_flow'), 3);
    // the frames' own pictures (both needed while fading from one to the next)
    const detA = this.pictureTexture(gl, fa.picture);
    const detB = fb ? this.pictureTexture(gl, fb.picture) : detA;
    const hasDet = !!detA && !!detB;
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, hasDet ? detA : this.fieldTexture(gl, fa.field));
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, hasDet ? detB : this.fieldTexture(gl, fa.field));
    gl.uniform1i(u('u_detA'), 4);
    gl.uniform1i(u('u_detB'), 5);
    gl.uniform1f(u('u_hasDet'), hasDet ? 1 : 0);
    // the infrared colouring: the frames' data packs through Windy's infrared colours
    const irA = this.irColour ? this.pictureTexture(gl, fa.ir?.url) : null;
    const irB = fb ? this.pictureTexture(gl, fb.ir?.url) : irA;
    const hasIr = !!irA && !!irB && !!fa.ir;
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, hasIr ? irA : this.fieldTexture(gl, fa.field));
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, hasIr ? irB : this.fieldTexture(gl, fa.field));
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture(gl));
    gl.uniform1i(u('u_irA'), 6);
    gl.uniform1i(u('u_irB'), 7);
    gl.uniform1i(u('u_lut'), 8);
    gl.uniform1f(u('u_hasIr'), hasIr ? 1 : 0);
    if (hasIr) {
      // the field covers the satellite box; the data pack its own box (both Mercator): uv maps across by an affine step
      const db = fa.ir!.bounds;
      const dx0 = mercatorUnitX(db.west), dx1 = mercatorUnitX(db.east), dy0 = mercatorUnitY(db.north), dy1 = mercatorUnitY(db.south);
      const sx = (bx1 - bx0) / (dx1 - dx0), sy = (by1 - by0) / (dy1 - dy0);
      gl.uniform4f(u('u_irAff'), sx, sy, (bx0 - dx0) / (dx1 - dx0), (by0 - dy0) / (dy1 - dy0));
    }
    gl.uniform1i(u('u_hasB'), fb ? 1 : 0);
    gl.uniform1i(u('u_hasFlow'), flow ? 1 : 0);
    gl.uniform1f(u('u_mixB'), fb ? frac : 0);
    if (flow) {
      gl.uniform4f(u('u_flowNodes'), flow.x0, flow.y0, flow.stepX, flow.stepY);
      gl.uniform2f(u('u_flowCount'), flow.cols, flow.rows);
    }
    gl.uniform3fv(u('u_near'), near);
    gl.uniform3fv(u('u_far'), far);
    gl.uniform2f(u('u_uvOrigin'), (ox - bx0) / (bx1 - bx0), (oy - by0) / (by1 - by0));
    gl.uniform2f(u('u_uvPerKm'), 1 / (kmPerUnit * (bx1 - bx0)), -1 / (kmPerUnit * (by1 - by0)));
    gl.uniform3fv(u('u_sun'), light);
    gl.uniform3fv(u('u_sunColor'), sunColor);
    gl.uniform3fv(u('u_skyColor'), sky);
    gl.uniform1f(u('u_exag'), this.exag);
    gl.uniform1f(u('u_steps'), this.phone ? 48 : 80);
    gl.uniform1f(u('u_shadow'), night ? 0.15 : 0.45);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    this.drewTarget = true;
  }

  /** The marched clouds scaled up onto the map. */
  render(gl: WebGL2RenderingContext): void {
    if (!this.drewTarget || !this.compProg || !this.target) return;
    const program = this.compProg.ready();
    if (!program) {
      this.map?.triggerRepaint();
      return;
    }
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.target);
    gl.uniform1i(this.uniform(gl, program, 'u_tex'), 0);
    gl.uniform1f(this.uniform(gl, program, 'u_opacity'), this.opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}

/** The direction toward the sun (east, north, up) at a place and time. */
export function sunDirection(timeMs: number, latDeg: number, lonDeg: number): [number, number, number] {
  const rad = Math.PI / 180;
  const el = sunElevationDeg(timeMs, latDeg, lonDeg) * rad;
  // the azimuth from the sun's elevation a few minutes later and its hour angle: east before noon, west after
  const d = new Date(timeMs);
  const dayOfYear = (timeMs - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000;
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1);
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma);
  const lat = latDeg * rad;
  const cosAz = (Math.sin(decl) - Math.sin(el) * Math.sin(lat)) / Math.max(1e-6, Math.cos(el) * Math.cos(lat));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))); // from north
  const later = sunElevationDeg(timeMs + 600_000, latDeg, lonDeg) * rad;
  if (later < el) az = 2 * Math.PI - az; // falling: the afternoon sun is in the west
  return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
}

function transform(m: ArrayLike<number>, v: number[]): number[] {
  const out = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) out[r] = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3];
  return out;
}

/** The inverse of a 4x4 column-major matrix (null when it has none). */
export function invert(m: ArrayLike<number>): number[] | null {
  const a = Array.from(m);
  const inv = new Array<number>(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (!det) return null;
  return inv.map(v => v / det);
}
