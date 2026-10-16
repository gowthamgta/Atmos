/**
 * Pure maths for turning a radar image's discrete intensity classes into a smooth, natural-looking field.
 *
 * IMD publishes each radar as a GIF with a handful of flat colours, so the intensity read from it is a staircase.
 * Stretching it with nearest-neighbour sampling gives blocky edges, and a hard-edged first class gives the bright rim
 * around every echo. The fix is to classify at the image's own resolution, reconstruct the intensity smoothly,
 * blur it, and fade the faintest values in over a wide band.
 */

/** Normalised 1-D Gaussian kernel (sums to 1). */
export function gaussianKernel(sigma: number, radius = Math.max(1, Math.ceil(sigma * 3))): Float32Array {
  const k = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** Separable blur of a square `size` x `size` field; edges are clamped. Returns a new array. */
export function blurSeparable(src: Float32Array, size: number, kernel: Float32Array): Float32Array {
  const radius = (kernel.length - 1) >> 1;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const nx = x + k < 0 ? 0 : x + k >= size ? size - 1 : x + k;
        sum += src[row + nx] * kernel[k + radius];
      }
      tmp[row + x] = sum;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const ny = y + k < 0 ? 0 : y + k >= size ? size - 1 : y + k;
        sum += tmp[ny * size + x] * kernel[k + radius];
      }
      out[y * size + x] = sum;
    }
  }
  return out;
}

/**
 * Bilinear resample of a `srcW` x `srcH` field onto a square `outSize` grid. The corners of the output line up with
 * the corners of the source, as nearest-neighbour sampling did before, but values between source pixels are now
 * interpolated instead of copied, so edges are no longer stair-stepped.
 */
export function resampleBilinear(src: Float32Array, srcW: number, srcH: number, outSize: number): Float32Array {
  const out = new Float32Array(outSize * outSize);
  const sx = srcW > 1 ? (srcW - 1) / (outSize - 1) : 0;
  const sy = srcH > 1 ? (srcH - 1) / (outSize - 1) : 0;
  for (let y = 0; y < outSize; y++) {
    const fy = y * sy;
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, srcH - 1);
    const wy = fy - y0;
    for (let x = 0; x < outSize; x++) {
      const fx = x * sx;
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const wx = fx - x0;
      const top = src[y0 * srcW + x0] * (1 - wx) + src[y0 * srcW + x1] * wx;
      const bottom = src[y1 * srcW + x0] * (1 - wx) + src[y1 * srcW + x1] * wx;
      out[y * outSize + x] = top * (1 - wy) + bottom * wy;
    }
  }
  return out;
}

/** Intensity below which an echo is invisible, and the intensity at which it is fully opaque. */
export const ECHO_FADE_START = 0.05;
export const ECHO_FADE_FULL = 0.4;

/**
 * Opacity factor 0..1 for an echo of intensity `v`: faint values (the fringe around a rain area, and the lightest
 * class) fade in gradually instead of appearing as a hard coloured outline.
 */
export function echoAlphaFeather(v: number): number {
  if (v <= ECHO_FADE_START) return 0;
  if (v >= ECHO_FADE_FULL) return 1;
  const t = (v - ECHO_FADE_START) / (ECHO_FADE_FULL - ECHO_FADE_START);
  return t * t * (3 - 2 * t);
}

/**
 * The radar colour scale: intensity (0 = nothing; v = (dBZ - 12) / 9.6, so 1.08 is 22 dBZ and 5 is 60 dBZ) to colour and opacity. These are
 * Windy's radar colours, sampled down its legend: indigo and blue for light rain, then teal, green, yellow, amber, orange, red-brown,
 * crimson and magenta-purple at 60 dBZ.
 */
export const RADAR_COLOR_STOPS = [
  { val: 0.0, r: 36, g: 24, b: 158, a: 0.0 }, // Transparent
  { val: 0.3, r: 36, g: 24, b: 158, a: 0.55 }, // the faintest echoes (about 12 dBZ and under)
  { val: 0.5, r: 14, g: 96, b: 154, a: 0.78 }, // 14.6 dBZ
  { val: 0.69, r: 4, g: 128, b: 136, a: 0.84 }, // 18.6 dBZ
  { val: 0.98, r: 2, g: 153, b: 144, a: 0.88 }, // 21.4 dBZ
  { val: 1.21, r: 3, g: 167, b: 133, a: 0.9 }, // 23.6 dBZ
  { val: 1.43, r: 20, g: 187, b: 131, a: 0.92 }, // 25.7 dBZ
  { val: 1.66, r: 62, g: 205, b: 125, a: 0.93 }, // 27.9 dBZ
  { val: 1.88, r: 75, g: 190, b: 86, a: 0.94 }, // 30 dBZ
  { val: 2.09, r: 125, g: 211, b: 76, a: 0.95 }, // 32.1 dBZ
  { val: 2.32, r: 175, g: 212, b: 44, a: 0.96 }, // 34.3 dBZ
  { val: 2.54, r: 210, g: 212, b: 27, a: 0.97 }, // 36.4 dBZ
  { val: 2.77, r: 235, g: 207, b: 22, a: 0.98 }, // 38.6 dBZ
  { val: 2.99, r: 227, g: 182, b: 5, a: 0.98 }, // 40.7 dBZ
  { val: 3.23, r: 242, g: 177, b: 21, a: 1 }, // 43 dBZ
  { val: 3.46, r: 241, g: 159, b: 33, a: 1 }, // 45.2 dBZ
  { val: 3.68, r: 233, g: 137, b: 51, a: 1 }, // 47.3 dBZ
  { val: 3.91, r: 210, g: 107, b: 49, a: 1 }, // 49.5 dBZ
  { val: 4.14, r: 205, g: 88, b: 70, a: 1 }, // 51.7 dBZ
  { val: 4.36, r: 199, g: 68, b: 82, a: 1 }, // 53.9 dBZ
  { val: 4.59, r: 185, g: 50, b: 93, a: 1 }, // 56.1 dBZ
  { val: 4.82, r: 168, g: 32, b: 98, a: 1 }, // 58.3 dBZ
  { val: 5, r: 145, g: 18, b: 105, a: 1 } // 60 dBZ
];

export function sampleRadarColorRamp(v: number): [number, number, number, number] {
  if (v <= RADAR_COLOR_STOPS[0].val) return [0, 0, 0, 0];
  if (v >= RADAR_COLOR_STOPS[RADAR_COLOR_STOPS.length - 1].val) {
    const last = RADAR_COLOR_STOPS[RADAR_COLOR_STOPS.length - 1];
    return [last.r, last.g, last.b, Math.round(last.a * 255)];
  }
  for (let i = 0; i < RADAR_COLOR_STOPS.length - 1; i++) {
    const s0 = RADAR_COLOR_STOPS[i];
    const s1 = RADAR_COLOR_STOPS[i + 1];
    if (v >= s0.val && v <= s1.val) {
      const t = (v - s0.val) / (s1.val - s0.val);
      const cr = Math.round(s0.r + (s1.r - s0.r) * t);
      const cg = Math.round(s0.g + (s1.g - s0.g) * t);
      const cb = Math.round(s0.b + (s1.b - s0.b) * t);
      const ca = Math.round((s0.a + (s1.a - s0.a) * t) * 255);
      return [cr, cg, cb, ca];
    }
  }
  return [0, 0, 0, 0];
}

/**
 * The radar is drawn in flat bands, like a rain radar map, not as a smooth gradient: the band edges in dBZ, and the dBZ whose colour
 * (from RADAR_COLOR_STOPS) fills the band below the first edge, between each pair, and above the last. The edges between bands are
 * smooth curves (the field is reconstructed smoothly) and are only anti-aliased, not blurred.
 */
export const RADAR_BAND_EDGES_DBZ = [20, 26, 32, 38, 44, 50, 56];
export const RADAR_BAND_COLOUR_DBZ = [16, 23, 29, 35, 41, 47, 53, 60];

/** The largest intensity the 8-bit display field can hold (the scale tops out at 5.2; above 6 is clipped). */
export const RADAR_FIELD_MAX = 6;

/** Intensity field to one byte per pixel (steps of about 0.024, far finer than the colour classes), for the GPU. */
export function quantizeRadarField(field: Float32Array): Uint8Array {
  const out = new Uint8Array(field.length);
  const k = 255 / RADAR_FIELD_MAX;
  for (let i = 0; i < field.length; i++) {
    const v = field[i];
    out[i] = v <= 0 ? 0 : v >= RADAR_FIELD_MAX ? 255 : Math.round(v * k);
  }
  return out;
}

export function dequantizeRadar(byte: number): number {
  return (byte * RADAR_FIELD_MAX) / 255;
}
