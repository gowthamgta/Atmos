import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { AdaptiveCount, INSTANCE_FLOATS, ParticleSystem, ViewState, WindFrame } from '../forecast/particle-system';

/**
 * Each particle is an instanced ribbon of TAIL_SEGMENTS pieces: its head at the particle, its tail trailing back along the way it came. The
 * velocity is taken to change evenly from the earlier one (at the tail) to the current one (at the head), so the tail is the path that gives:
 * straight in a steady wind, a smooth curve through a turn. Its sides are softened over a pixel (no jagged edges).
 */
const VERTEX = `#version 300 es
uniform mat4 u_matrix;
uniform vec2 u_css;       // map size in CSS pixels
uniform float u_tail;     // tail length in seconds of travel
uniform float u_half;     // half line width in CSS pixels, with the softened edge
in vec2 a_corner;         // x: 0 head .. 1 tail; y: -1 / +1 side
in vec2 a_pos;            // mercator position of the head (per instance)
in vec2 a_vel;            // screen velocity in px/s, y down (per instance)
in float a_alpha;         // (per instance)
in vec2 a_prev;           // the earlier screen velocity (per instance)
out float v_alpha;
out float v_side;         // distance from the middle of the line, in CSS pixels
void main() {
  vec4 clip = u_matrix * vec4(a_pos, 0.0, 1.0);
  float t = a_corner.x;
  // back along the path: the integral of a velocity going from a_vel (now) to a_prev (u_tail ago)
  vec2 along = -u_tail * (a_vel * t + (a_prev - a_vel) * (0.5 * t * t));
  vec2 d = mix(a_vel, a_prev, t);
  float speed = length(d);
  vec2 dir = speed > 0.001 ? d / speed : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 offsetPx = along + perp * u_half * a_corner.y;
  vec2 ndc = vec2(offsetPx.x / (u_css.x * 0.5), -offsetPx.y / (u_css.y * 0.5));
  gl_Position = clip + vec4(ndc * clip.w, 0.0, 0.0);
  v_alpha = a_alpha * (1.0 - t);   // opaque head fading to a transparent tail
  v_side = u_half * a_corner.y;
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
uniform highp float u_half;   // the same precision as in the vertex shader (shared uniforms must match)
in float v_alpha;
in float v_side;
out vec4 outColor;
void main() {
  float edge = 1.0 - smoothstep(u_half - 1.2, u_half, abs(v_side));   // a soft edge a pixel wide
  float a = v_alpha * edge;
  outColor = vec4(vec3(1.0) * a, a);   // premultiplied white
}`;

/** Pieces of each tail (enough for a smooth curve). */
const TAIL_SEGMENTS = 6;
/** The ribbon's corners: (t, side) from the head (t = 0) to the tail (t = 1), as a triangle strip. */
const RIBBON = new Float32Array(Array.from({ length: TAIL_SEGMENTS + 1 }, (_, k) => [k / TAIL_SEGMENTS, -1, k / TAIL_SEGMENTS, 1]).flat());

const TAIL_SECONDS = 0.32; // the streak's length in seconds of travel (about 2.2 px per m/s of wind on screen)
const LINE_WIDTH_CSS_PX = 1.4;
const MIN_COUNT = 2500;

/** MapLibre custom layer animating wind as particle streaks over the map. */
export class WindParticlesLayer implements CustomLayerInterface {
  readonly id = 'forecast-wind-particles';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapLibreMap | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private cornerBuf: WebGLBuffer | null = null;
  private instanceBuf: WebGLBuffer | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private system: ParticleSystem;
  private instances: Float32Array;
  private readonly budget: AdaptiveCount;
  private wind: WindFrame | null = null;
  private visible = false;
  private needsReset = true;
  private lastTime = 0;

  constructor(maxCount = 16000) {
    this.system = new ParticleSystem(maxCount);
    this.instances = new Float32Array(maxCount * INSTANCE_FLOATS);
    this.budget = new AdaptiveCount(Math.min(MIN_COUNT, Math.max(500, Math.floor(maxCount * 0.4))), maxCount);
  }

  /** The smoothed time between frames, for the performance meter. */
  get frameMs(): number {
    return this.budget.frameMs;
  }

  /** Current particle budget (reduced automatically on slow devices). */
  get particleCount(): number {
    return this.system.count;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.lastTime = 0;
    this.budget.reset();
    this.map?.triggerRepaint();
  }

  /** New wind data (or just a new time blend of the same data). */
  setWind(wind: WindFrame | null): void {
    const gridChanged = !this.wind || !wind || this.wind.grid !== wind.grid;
    this.wind = wind;
    if (gridChanged) this.needsReset = true;
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.program = this.link(gl, VERTEX, FRAGMENT);
    for (const name of ['u_matrix', 'u_css', 'u_tail', 'u_half']) this.uniforms[name] = gl.getUniformLocation(this.program, name);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, RIBBON, gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(this.program, 'a_corner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

    this.instanceBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.instances.byteLength, gl.DYNAMIC_DRAW);
    const stride = INSTANCE_FLOATS * 4;
    const layout: [string, number, number][] = [['a_pos', 2, 0], ['a_vel', 2, 8], ['a_alpha', 1, 16], ['a_prev', 2, 20]];
    for (const [name, size, offset] of layout) {
      const loc = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    if (this.cornerBuf) gl.deleteBuffer(this.cornerBuf);
    if (this.instanceBuf) gl.deleteBuffer(this.instanceBuf);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.cornerBuf = this.instanceBuf = this.vao = this.program = null;
    this.map = null;
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const map = this.map;
    if (!map || !this.program || !this.visible || !this.wind) return;

    const now = performance.now();
    // the real time between frames (up to a tenth of a second: a slower device's flow keeps its speed instead of crawling; a longer gap is a
    // hidden tab or a pause)
    const dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, 0.1) : 0;
    this.lastTime = now;
    const next = this.budget.update(now, dt * 1000, this.system.count);
    if (next !== null) this.system.setCount(next);

    const b = map.getBounds();
    const view: ViewState = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth(), zoom: map.getZoom() };
    if (this.needsReset) {
      this.system.reset(view, this.wind.grid);
      this.needsReset = false;
    }
    this.system.step(dt, this.wind, view);
    const n = this.system.writeInstances(this.instances);
    if (n === 0) {
      map.triggerRepaint();
      return;
    }

    const canvas = map.getCanvas();
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instances, 0, n * INSTANCE_FLOATS);
    gl.uniformMatrix4fv(this.uniforms['u_matrix'], false, options.defaultProjectionData.mainMatrix as unknown as Float32List);
    gl.uniform2f(this.uniforms['u_css'], canvas.clientWidth, canvas.clientHeight);
    gl.uniform1f(this.uniforms['u_tail'], TAIL_SECONDS);
    gl.uniform1f(this.uniforms['u_half'], LINE_WIDTH_CSS_PX / 2 + 0.6); // the soft edge lies outside the line's own width
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, RIBBON.length / 2, n);
    gl.bindVertexArray(null);

    map.triggerRepaint(); // keep animating
  }

  private link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
    const compile = (type: number, src: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`wind shader: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`wind program: ${gl.getProgramInfoLog(program)}`);
    return program;
  }
}
