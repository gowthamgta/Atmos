import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { mercatorUnitX, mercatorUnitY } from '../forecast/forecast.model';
import { ECHO_FADE_FULL, ECHO_FADE_START, RADAR_COLOR_STOPS, RADAR_FIELD_MAX } from '../services/radar-field';

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
    t = t * t * (3.0 - 2.0 * t);
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

/**
 * The radar is drawn from its intensity, not from a picture that was coloured in advance. Each screen pixel reads the
 * intensity with a bicubic (Catmull-Rom) filter, steepens it very slightly (unsharp mask), and only then looks up the
 * colour, so rain edges and contours stay smooth and crisp at any zoom instead of turning into blurry coloured blocks.
 * Zoomed out, the mipmapped hardware filter is used so thin echoes do not shimmer.
 */
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_field;   // R8: intensity / ${RADAR_FIELD_MAX}
uniform vec4 u_box;          // mercator x0 and x1 of the mosaic (its west and east edges); y0, y1 unused
uniform vec2 u_lat;          // latitude (degrees) of the top and the bottom row
uniform ivec2 u_size;
uniform float u_opacity;
uniform float u_sharpen;
in vec2 v_merc;
out vec4 outColor;

${rampGlsl()}

vec4 weights(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}

// Bicubic intensity. Not clamped to the neighbouring texels: that would flatten the colour classes into stepped
// plateaus with jagged diagonals. The small overshoot of the filter only moves a contour a fraction of a pixel.
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
  bool magnifying = max(length(gx * vec2(u_size)), length(gy * vec2(u_size))) < 1.0;

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

  vec4 c = ramp(v);
  float feather = smoothstep(${f(ECHO_FADE_START)}, ${f(ECHO_FADE_FULL)}, v);
  float a = c.a * feather * u_opacity;
  if (a <= 0.001) discard;
  outColor = vec4(c.rgb * a, a);   // premultiplied for MapLibre's blend function
}`;

export interface RadarLayerFrame {
  /** Intensity, one byte per pixel (intensity / RADAR_FIELD_MAX * 255), row 0 at the north edge. */
  field: Uint8Array;
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
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly textures = new Map<Uint8Array, WebGLTexture>(); // insertion order = least recently used first
  private frame: RadarLayerFrame | null = null;
  private box: [number, number, number, number] = [0, 0, 1, 1];
  private lat: [number, number] = [1, 0];
  private opacity = 1;
  private sharpen = 0.12;

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

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    const compile = (type: number, src: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`radar shader: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`radar program: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    for (const name of ['u_matrix', 'u_field', 'u_box', 'u_lat', 'u_size', 'u_opacity', 'u_sharpen']) this.uniforms[name] = gl.getUniformLocation(program, name);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.uploadQuad();
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    for (const tex of this.textures.values()) gl.deleteTexture(tex);
    this.textures.clear();
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.vbo = this.vao = this.program = null;
    this.map = null;
    this.gl = null;
  }

  private uploadQuad(): void {
    const { gl, vao, vbo, program } = this;
    if (!gl || !vao || !vbo || !program) return;
    const [x0, y0, x1, y1] = this.box;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x0, y0, x1, y0, x0, y1, x1, y1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private textureFor(gl: WebGL2RenderingContext, frame: RadarLayerFrame): WebGLTexture {
    const cached = this.textures.get(frame.field);
    if (cached) {
      this.textures.delete(frame.field);
      this.textures.set(frame.field, cached); // most recently used
      return cached;
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // rows are not a multiple of four bytes
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, frame.width, frame.height, 0, gl.RED, gl.UNSIGNED_BYTE, frame.field);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(frame.field, tex);
    while (this.textures.size > RadarFieldLayer.MAX_TEXTURES) {
      const oldest = this.textures.keys().next().value as Uint8Array;
      if (oldest === frame.field) break;
      gl.deleteTexture(this.textures.get(oldest)!);
      this.textures.delete(oldest);
    }
    return tex;
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const { program, frame } = this;
    if (!program || !frame || this.opacity <= 0.001) return;
    const tex = this.textureFor(gl, frame);
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const u = this.uniforms;
    gl.uniformMatrix4fv(u['u_matrix'], false, options.defaultProjectionData.mainMatrix as unknown as Float32List);
    gl.uniform1i(u['u_field'], 0);
    gl.uniform4f(u['u_box'], this.box[0], this.box[1], this.box[2], this.box[3]);
    gl.uniform2f(u['u_lat'], this.lat[0], this.lat[1]);
    gl.uniform2i(u['u_size'], frame.width, frame.height);
    gl.uniform1f(u['u_opacity'], this.opacity);
    gl.uniform1f(u['u_sharpen'], this.sharpen);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
