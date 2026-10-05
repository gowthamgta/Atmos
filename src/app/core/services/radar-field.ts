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
export const ECHO_FADE_FULL = 0.9;

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
