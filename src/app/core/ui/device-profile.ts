/**
 * What the device can take. Phones (and other small touch screens) get lighter settings by default: fewer texture reads
 * per pixel in the forecast shader, a smaller radar mosaic. Everything stays switchable by the user where it
 * changes the look (the terrain relief switch in the layer menu).
 */
export function isPhone(): boolean {
  // through globalThis, not `window`: this module is also part of the satellite worker, which has no window (and is never a phone's screen)
  const screen = globalThis as { innerWidth?: number; ontouchstart?: unknown };
  if (typeof screen.innerWidth !== 'number') return false;
  return screen.innerWidth < 700 || ('ontouchstart' in screen && screen.innerWidth < 900);
}

/** Largest side of the radar mosaic (pixels): 0.5 km per pixel where it fits, coarser over all of India. */
export function radarMosaicMaxPx(phone: boolean): number {
  // the radars span all of India (about 3,500 km with their 500 km pictures): 4096 (a texture size desktop GPUs take) keeps a desktop
  // near 0.85 km a pixel; a phone stays at 2300 for its memory
  return phone ? 2300 : 4096;
}

/** Screen pixel ratio cap: phones draw at up to 2x (the forecast shading is light enough there), desktops at native. */
export function maxPixelRatio(phone: boolean, deviceRatio: number): number {
  return phone ? Math.min(deviceRatio, 2) : deviceRatio;
}

/**
 * What the browser says about the hardware, before anything is drawn: few processor cores, little memory, or a GPU that is software (no
 * graphics chip to speak of). Any one of them makes the device count as weak (see LowPowerService, which also measures the frame rate).
 */
export function weakHardware(cores = navigator.hardwareConcurrency, memoryGb = (navigator as { deviceMemory?: number }).deviceMemory, renderer = gpuRenderer()): boolean {
  if (typeof cores === 'number' && cores > 0 && cores <= 2) return true;
  if (typeof memoryGb === 'number' && memoryGb > 0 && memoryGb <= 2) return true;
  return /swiftshader|llvmpipe|software|basic render|mesa offscreen/i.test(renderer);
}

/** The GPU's name as WebGL reports it ('' when it cannot be had). */
export function gpuRenderer(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl');
    if (!gl) return 'software';   // no WebGL at all
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return '';
  }
}

/** The visitor's own choice of the terrain relief (the layer menu), kept so the automatic choice never overrides it. */
export const RELIEF_CHOICE_KEY = 'atmosiq.relief.choice';

/** Below this many frames a second (median, the map drawing) the device counts as weak. */
export const WEAK_FPS = 36;
/** The pixel ratio a weak device draws the map at (at most): a third fewer pixels to colour on a 2x screen, still sharp. */
export const WEAK_PIXEL_RATIO = 1.5;
