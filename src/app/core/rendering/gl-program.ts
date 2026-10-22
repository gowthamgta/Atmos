/**
 * A WebGL program compiled without holding up the page. Asking whether a shader compiled right after compiling it makes the browser wait for the
 * GPU driver to finish (measured: about 300 ms of main thread on a phone-speed CPU, e2e/perf.mjs). With KHR_parallel_shader_compile (Chrome,
 * Android, Edge) the driver compiles in the background and `ready()` says when it is done, so a layer simply skips the frames until then. Without
 * the extension the first `ready()` checks the result as before.
 */
export class PendingProgram {
  private program: WebGLProgram | null;
  private done: WebGLProgram | null = null;
  private readonly parallel: { COMPLETION_STATUS_KHR: number } | null;
  private readonly shaders: { shader: WebGLShader; kind: string }[] = [];

  /** `attributes` are bound to locations 0, 1, ... before the link, so vertex arrays can be set up before the program is ready. */
  constructor(private readonly gl: WebGL2RenderingContext, vertex: string, fragment: string, private readonly label: string, attributes: readonly string[] = ['a_pos']) {
    this.parallel = gl.getExtension('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number } | null;
    const program = gl.createProgram()!;
    for (const [type, src, kind] of [[gl.VERTEX_SHADER, vertex, 'vertex'], [gl.FRAGMENT_SHADER, fragment, 'fragment']] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      this.shaders.push({ shader, kind });
    }
    attributes.forEach((name, i) => gl.bindAttribLocation(program, i, name));
    gl.linkProgram(program);
    this.program = program;
  }

  /** The program once it is compiled and linked, or null while the driver is still at it. Throws (with the driver's log) if it failed. */
  ready(): WebGLProgram | null {
    if (this.done) return this.done;
    const gl = this.gl;
    const program = this.program;
    if (!program) return null;
    if (this.parallel && !gl.getProgramParameter(program, this.parallel.COMPLETION_STATUS_KHR)) return null;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const failed = this.shaders.find(s => !gl.getShaderParameter(s.shader, gl.COMPILE_STATUS));
      const log = failed ? `${failed.kind} shader: ${gl.getShaderInfoLog(failed.shader)}` : `program: ${gl.getProgramInfoLog(program)}`;
      this.program = null;
      throw new Error(`${this.label} ${log}`);
    }
    for (const s of this.shaders) gl.deleteShader(s.shader); // they stay attached to the program until it goes
    this.done = program;
    return program;
  }

  /** The program whether or not it is ready (to delete it). */
  get handle(): WebGLProgram | null {
    return this.done ?? this.program;
  }
}
