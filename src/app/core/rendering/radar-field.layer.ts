import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { mercatorUnitX, mercatorUnitY } from '../forecast/forecast.model';
import type { TerrainData } from '../forecast/terrain.service';
import { ECHO_FADE_FULL, ECHO_FADE_START, RADAR_BAND_COLOUR_DBZ, RADAR_BAND_EDGES_DBZ, RADAR_COLOR_STOPS, RADAR_FIELD_MAX } from '../services/radar-field';
import { TERRAIN_TILE_GLSL, TERRAIN_TILE_UNIFORMS, TerrainTileGpu } from './terrain-tile-gpu';
import { PendingProgram } from './gl-program';

const VERTEX = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;
out vec2 v_merc;
void main() {
  v_merc = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const f = (n: number) => n.toFixed(6);

/** The radar colour scale as GLSL: smooth steps between the stops, the same as sampleRadarColorRamp on the CPU. */
function rampGlsl(): string {
  const stops = RADAR_COLOR_STOPS;
  const col = (s: (typeof stops)[number]) => `vec4(${f(s.r / 255)}, ${f(s.g / 255)}, ${f(s.b / 255)}, ${f(s.a)})`;
  const branches = stops
    .slice(0, -1)
    .map((s0, i) => {
      const s1 = stops[i + 1];
      return `  if (v >= ${f(s0.val)} && v < ${f(s1.val)}) {
    float t = (v - ${f(s0.val)}) / ${f(s1.val - s0.val)};
    return mix(${col(s0)}, ${col(s1)}, t);
  }`;
    })
    .join('\n');
  return `vec4 ramp(float v) {
  if (v <= ${f(stops[0].val)}) return vec4(0.0);
${branches}
  return ${col(stops[stops.length - 1])};
}`;
}

/** The flat bands as GLSL: the colour of ramp() at each band's own dBZ, switching at the edges over about a pixel (anti-aliased contours). */
function bandGlsl(): string {
  const v = (dbz: number) => f((dbz - 12) / 9.6);
  const colours = RADAR_BAND_COLOUR_DBZ.map(d => `ramp(${v(d)})`);
  const steps = RADAR_BAND_EDGES_DBZ.map((e, i) => `  c = mix(c, ${colours[i + 1]}, smoothstep(${v(e)} - w, ${v(e)} + w, v));`).join('\n');
  return `vec4 band(float v) {
  float w = max(fwidth(v), 0.004) * 0.75;
  vec4 c = ${colours[0]};
${steps}
  return c;
}`;
}

/**
 * The radar is drawn from its intensity, not from a picture that was coloured in advance. Each screen pixel reads the
 * intensity with a bicubic (Catmull-Rom) filter, steepens it very slightly (unsharp mask), and only then looks up the
 * colour, so rain edges and contours stay smooth and crisp at any zoom instead of turning into blurry coloured blocks.
 * Zoomed out, the mipmapped hardware filter is used so thin echoes do not shimmer.
 *
 * The 90 m relief is shaded into the echoes, lit from the north-west as in the forecast colours, so the Ghats and the valleys read through a storm
 * instead of disappearing under it (the terrain tiles come from the same code as the forecast layer: see terrain-tile-gpu.ts).
 */
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision lowp sampler2DArray;   // the terrain tiles (GLSL ES 3.00 wants a precision for every sampler type)
uniform sampler2D u_field;   // R8: intensity / ${RADAR_FIELD_MAX}
uniform sampler2D u_fade;    // R8: how fully each pixel is drawn (1: in full; less where the echo is older than another radar's scan there)
uniform vec4 u_box;          // mercator x0 and x1 of the mosaic (its west and east edges); y0, y1 unused
uniform vec2 u_lat;          // latitude (degrees) of the top and the bottom row
uniform ivec2 u_size;
uniform float u_opacity;
uniform float u_sharpen;
uniform float u_relief;      // 0..1 strength of the relief shading
uniform int u_terrainOn;     // 1 when the terrain tiles are bound
uniform int u_lite;          // 1: phone mode, the relief slope from screen differences (far fewer texture reads)
uniform vec4 u_terrainBox;   // west, south, east, north: where the 90 m terrain is; outside it there is no shading
in vec2 v_merc;
out vec4 outColor;
${TERRAIN_TILE_GLSL}
${rampGlsl()}
${bandGlsl()}

// Catmull-Rom weights: the curve passes through every sample, so the intensity of a cell is what the radar measured. (A B-spline, which
// averages its neighbours, takes a small cell down to a fraction of its strength; the field is already smoothed when it is built.)
vec4 weights(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(
    -0.5 * t3 + t2 - 0.5 * t,
    1.5 * t3 - 2.5 * t2 + 1.0,
    -1.5 * t3 + 2.0 * t2 + 0.5 * t,
    0.5 * t3 - 0.5 * t2
  );
}

// Bicubic (Catmull-Rom) intensity: smooth contours at any zoom, and the strength of every cell kept.
float bicubic(vec2 px) {
  vec2 p = px - 0.5;
  ivec2 i1 = ivec2(floor(p));
  vec2 fr = p - vec2(i1);
  vec4 wx = weights(fr.x);
  vec4 wy = weights(fr.y);
  float sum = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      ivec2 q = clamp(i1 + ivec2(i - 1, j - 1), ivec2(0), u_size - 1);
      sum += texelFetch(u_field, q, 0).r * wx[i] * wy[j];
    }
  }
  return clamp(sum, 0.0, 1.0);
}

// How the 90 m ground lights an echo: hills lit from the north-west, 1.0 on flat ground, at sea and where the ground is not loaded.
float reliefShade(float lat, float lon) {
  if (lon < u_terrainBox.x || lon > u_terrainBox.z || lat < u_terrainBox.y || lat > u_terrainBox.w) return 1.0;
  vec3 tile = tileTerrain(lat, lon);
  if (tile.z < 0.5) return 1.0;
  vec2 slope;
  if (u_lite == 0) {
    slope = tileSlope(lat, lon);
  } else {
    // the screen-space slope of the ground (one terrain read instead of sixteen), in metres per metre
    float mPerPx = max(length(dFdx(v_merc)) * 40075016.686 * cos(radians(lat)), 1.0);
    slope = vec2(dFdx(tile.x), -dFdy(tile.x)) / mPerPx;
  }
  vec3 n = normalize(vec3(-slope * 3.0, 1.0));
  vec3 light = normalize(vec3(-0.55, 0.55, 0.63));
  float shade = dot(n, light) / light.z;
  return mix(1.0, clamp(1.0 + u_relief * (shade - 1.0), 0.55, 1.4), tile.y);
}

void main() {
  // The mosaic's rows are evenly spaced in latitude, columns in longitude (= mercator x). The screen is mercator, so
  // the row comes from this pixel's latitude; mapping it linearly in mercator would shift the picture by up to 5 km.
  float lat = degrees(atan(sinh(3.14159265358979 * (1.0 - 2.0 * v_merc.y))));
  vec2 uv = vec2((v_merc.x - u_box.x) / (u_box.z - u_box.x), (u_lat.x - lat) / (u_lat.x - u_lat.y));
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  // the first and last row/column sit on the edges of the box (index = fraction * (size - 1)), centres at +0.5
  vec2 px = uv * (vec2(u_size) - 1.0) + 0.5;
  vec2 gx = dFdx(uv);
  vec2 gy = dFdy(uv);
  bool magnifying = max(length(gx * vec2(u_size)), length(gy * vec2(u_size))) < 1.6;

  vec2 tc = px / vec2(u_size); // texture coordinates of the same point
  float v;
  if (magnifying) {
    v = bicubic(px);
    if (u_sharpen > 0.0) {
      vec2 d = 2.0 / vec2(u_size);
      float blur = (textureLod(u_field, tc + vec2(d.x, 0.0), 0.0).r + textureLod(u_field, tc - vec2(d.x, 0.0), 0.0).r +
                    textureLod(u_field, tc + vec2(0.0, d.y), 0.0).r + textureLod(u_field, tc - vec2(0.0, d.y), 0.0).r) * 0.25;
      v = clamp(v + u_sharpen * (v - blur), 0.0, 1.0);
    }
  } else {
    v = textureGrad(u_field, tc, gx, gy).r;
  }
  v *= ${f(RADAR_FIELD_MAX)};

  vec4 c = band(v);
  float feather = smoothstep(${f(ECHO_FADE_START)}, ${f(ECHO_FADE_FULL)}, v);
  float a = c.a * feather * u_opacity * texture(u_fade, tc).r;
  if (a <= 0.001) discard;
  vec3 rgb = c.rgb;
  if (u_terrainOn == 1 && u_relief > 0.0) rgb *= reliefShade(lat, v_merc.x * 360.0 - 180.0);
  outColor = vec4(rgb * a, a);   // premultiplied for MapLibre's blend function
}`;

export interface RadarLayerFrame {
  /** Intensity, one byte per pixel (intensity / RADAR_FIELD_MAX * 255), row 0 at the north edge. */
  field: Uint8Array;
  /** How fully each pixel is drawn, one byte per pixel like `field` (255: in full). Absent: everything in full. */
  fade?: Uint8Array;
  width: number;
  height: number;
  /** Corners [lng, lat]: NW, NE, SE, SW. */
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
}

/** MapLibre custom layer drawing the radar mosaic from its intensity, with smooth bicubic magnification. */
export class RadarFieldLayer implements CustomLayerInterface {
  readonly id = 'radar-field-layer';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;
  private static readonly MAX_TEXTURES = 9;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private pending: PendingProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly textures = new Map<Uint8Array, WebGLTexture>(); // insertion order = least recently used first
  private readonly fadeTextures = new Map<Uint8Array, WebGLTexture>();
  /** One white pixel: the fade of a picture that has none (everything drawn in full). */
  private noFade: WebGLTexture | null = null;
  private frame: RadarLayerFrame | null = null;
  private box: [number, number, number, number] = [0, 0, 1, 1];
  private lat: [number, number] = [1, 0];
  private opacity = 1;
  private sharpen = 0.0;
  /** The 90 m terrain tiles of the view on the GPU (shared code with the forecast layer). */
  private readonly tiles = new TerrainTileGpu('radar');
  private relief = 0;
  private lite = false;

  /** The mosaic to draw (null hides the layer). */
  setFrame(frame: RadarLayerFrame | null): void {
    this.frame = frame;
    if (frame) {
      const [nw, , se] = frame.coordinates;
      this.box = [mercatorUnitX(nw[0]), mercatorUnitY(nw[1]), mercatorUnitX(se[0]), mercatorUnitY(se[1])];
      this.lat = [nw[1], se[1]];
      this.uploadQuad();
    }
    this.map?.triggerRepaint();
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.map?.triggerRepaint();
  }

  /** The terrain to shade by (null: none). The tiles of the view are loaded only while the relief strength is above zero. */
  setTerrain(data: TerrainData | null): void {
    this.tiles.setTerrain(data, this.gl);
    this.map?.triggerRepaint();
  }

  /** Strength (0..1) of the relief shading over land; 0 draws the echoes plain. */
  setRelief(strength: number): void {
    if (this.relief === strength) return;
    this.relief = strength;
    this.map?.triggerRepaint();
  }

  /** Phone mode: the relief slope from screen-space differences of the terrain, not four extra terrain reads per pixel. */
  setLite(lite: boolean): void {
    if (this.lite === lite) return;
    this.lite = lite;
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    // compiled in the background (see gl-program.ts); drawing starts on the first frame it is ready
    this.pending = new PendingProgram(gl, VERTEX, FRAGMENT, 'radar');
    this.program = null;
    this.tiles.attach(map, gl);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.uploadQuad();
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    for (const tex of this.textures.values()) gl.deleteTexture(tex);
    for (const tex of this.fadeTextures.values()) gl.deleteTexture(tex);
    this.fadeTextures.clear();
    if (this.noFade) gl.deleteTexture(this.noFade);
    this.noFade = null;
    this.textures.clear();
    this.tiles.detach(gl);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    const handle = this.program ?? this.pending?.handle;
    if (handle) gl.deleteProgram(handle);
    this.pending = null;
    this.vbo = this.vao = this.program = null;
    this.map = null;
    this.gl = null;
  }

  private uploadQuad(): void {
    const { gl, vao, vbo } = this;
    if (!gl || !vao || !vbo) return;
    const [x0, y0, x1, y1] = this.box;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x0, y0, x1, y0, x0, y1, x1, y1]), gl.STATIC_DRAW);
    const loc = 0; // a_pos, bound to 0 before the link (gl-program.ts)
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** A one-byte-per-pixel picture of the frame (its intensity or its fade) on the GPU, uploaded once and kept for the last few frames. */
  private textureFor(gl: WebGL2RenderingContext, frame: RadarLayerFrame, data: Uint8Array = frame.field, cache = this.textures): WebGLTexture {
    const cached = cache.get(data);
    if (cached) {
      cache.delete(data);
      cache.set(data, cached); // most recently used
      return cached;
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // rows are not a multiple of four bytes
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, frame.width, frame.height, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    cache.set(data, tex);
    while (cache.size > RadarFieldLayer.MAX_TEXTURES) {
      const oldest = cache.keys().next().value as Uint8Array;
      if (oldest === data) break;
      gl.deleteTexture(cache.get(oldest)!);
      cache.delete(oldest);
    }
    return tex;
  }

  /** The frame's fade on the GPU, or one white pixel when it has none. */
  private fadeTextureFor(gl: WebGL2RenderingContext, frame: RadarLayerFrame): WebGLTexture {
    if (frame.fade) return this.textureFor(gl, frame, frame.fade, this.fadeTextures);
    if (!this.noFade) {
      this.noFade = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.noFade);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    return this.noFade;
  }

  /** The program once the driver has it ready, with its uniforms looked up (false while it is still compiling: another frame is asked for). */
  private takeProgram(gl: WebGL2RenderingContext): boolean {
    const program = this.pending?.ready();
    if (!program) {
      if (this.pending) this.map?.triggerRepaint();
      return false;
    }
    this.program = program;
    for (const name of ['u_matrix', 'u_field', 'u_fade', 'u_box', 'u_lat', 'u_size', 'u_opacity', 'u_sharpen', 'u_relief', 'u_terrainOn', 'u_lite', 'u_terrainBox', ...TERRAIN_TILE_UNIFORMS]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    return true;
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.program && !this.takeProgram(gl)) return;
    const { program, frame } = this;
    if (!program || !frame || this.opacity <= 0.001) return;
    const tex = this.textureFor(gl, frame);
    const fadeTex = this.fadeTextureFor(gl, frame);
    // the ground is only read (and its tiles only loaded) while the relief is wanted
    const wantRelief = this.relief > 0 && this.tiles.data !== null;
    if (wantRelief) this.tiles.update(gl);
    const terrainOn = wantRelief && this.tiles.ready;
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fadeTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.tiles.bind(gl, terrainOn);
    const u = this.uniforms;
    gl.uniformMatrix4fv(u['u_matrix'], false, options.defaultProjectionData.mainMatrix as unknown as Float32List);
    gl.uniform1i(u['u_field'], 0);
    gl.uniform1i(u['u_fade'], 1);
    gl.uniform4f(u['u_box'], this.box[0], this.box[1], this.box[2], this.box[3]);
    gl.uniform2f(u['u_lat'], this.lat[0], this.lat[1]);
    gl.uniform2i(u['u_size'], frame.width, frame.height);
    gl.uniform1f(u['u_opacity'], this.opacity);
    gl.uniform1f(u['u_sharpen'], this.sharpen);
    gl.uniform1i(u['u_terrainOn'], terrainOn ? 1 : 0);
    gl.uniform1f(u['u_relief'], terrainOn ? this.relief : 0);
    gl.uniform1i(u['u_lite'], this.lite ? 1 : 0);
    this.tiles.setUniforms(gl, u, terrainOn);
    const domain = this.tiles.data?.meta.domain;
    if (terrainOn && domain) gl.uniform4f(u['u_terrainBox'], domain.lonMin, domain.latMin, domain.lonMax, domain.latMax);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
