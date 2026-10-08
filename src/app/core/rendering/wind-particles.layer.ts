import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { INSTANCE_FLOATS, ParticleSystem, ViewState, WindFrame } from '../forecast/particle-system';

/** Each particle is an instanced quad: its head at the particle, a tail trailing against the wind. */
const VERTEX = `#version 300 es
uniform mat4 u_matrix;
uniform vec2 u_css;       // map size in CSS pixels
uniform float u_tail;     // tail length in seconds of travel
uniform float u_half;     // half line width in CSS pixels
in vec2 a_corner;         // x: 0 head, 1 tail; y: -1 / +1 side
in vec2 a_pos;            // mercator position of the head (per instance)
in vec2 a_vel;            // screen velocity in px/s, y down (per instance)
in float a_alpha;         // (per instance)
out float v_alpha;
void main() {
  vec4 clip = u_matrix * vec4(a_pos, 0.0, 1.0);
  float speed = length(a_vel);
  vec2 dir = speed > 0.001 ? a_vel / speed : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 offsetPx = -a_vel * u_tail * a_corner.x + perp * u_half * a_corner.y;
  vec2 ndc = vec2(offsetPx.x / (u_css.x * 0.5), -offsetPx.y / (u_css.y * 0.5));
  gl_Position = clip + vec4(ndc * clip.w, 0.0, 0.0);
  v_alpha = a_alpha * (1.0 - a_corner.x);   // opaque head fading to a transparent tail
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in float v_alpha;
out vec4 outColor;
void main() {
  outColor = vec4(vec3(1.0) * v_alpha, v_alpha);   // premultiplied white
}`;

const TAIL_SECONDS = 0.45;
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
  private readonly minCount: number;
  private wind: WindFrame | null = null;
  private visible = false;
  private needsReset = true;
  private lastTime = 0;
  private slowSince = 0;
  private emaDt = 16;

  constructor(maxCount = 11000) {
    this.system = new ParticleSystem(maxCount);
    this.instances = new Float32Array(maxCount * INSTANCE_FLOATS);
    this.minCount = Math.min(MIN_COUNT, Math.max(500, Math.floor(maxCount * 0.4)));
  }

  /** Current particle budget (reduced automatically on slow devices). */
  get particleCount(): number {
    return this.system.count;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.lastTime = 0;
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
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(this.program, 'a_corner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

    this.instanceBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.instances.byteLength, gl.DYNAMIC_DRAW);
    const stride = INSTANCE_FLOATS * 4;
    const layout: [string, number, number][] = [['a_pos', 2, 0], ['a_vel', 2, 8], ['a_alpha', 1, 16]];
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
    const dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, 0.05) : 0;
    this.lastTime = now;
    this.adaptCount(now, dt * 1000);

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
    gl.uniform1f(this.uniforms['u_half'], LINE_WIDTH_CSS_PX / 2);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);

    map.triggerRepaint(); // keep animating
  }

  /** Drops 15% of the particles when frames stay slow for a second (never below a usable minimum). */
  private adaptCount(now: number, dtMs: number): void {
    if (dtMs <= 0) return;
    this.emaDt = this.emaDt * 0.9 + dtMs * 0.1;
    if (this.emaDt > 28) {
      this.slowSince ||= now;
      if (now - this.slowSince > 1000 && this.system.count > this.minCount) {
        this.system.setCount(Math.max(this.minCount, this.system.count * 0.85));
        this.slowSince = now;
      }
    } else {
      this.slowSince = 0;
    }
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
