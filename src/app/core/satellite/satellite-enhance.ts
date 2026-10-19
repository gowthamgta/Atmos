/**
 * Tidying of the satellite pictures, done in the worker on plain typed arrays (no image library).
 *
 * Everything on EUMETView except the high-resolution visible channel (HRV) is a 3 km sensor seen at a slant, so over India its
 * pixels are 4-6 km wide: on the finer grid of the picture they show as steps, and sharpening makes the steps stand out. The
 * infrared picture, and the infrared that sits in the blue channel of the HRV picture, are blurred a little (about a third of a
 * source pixel) so the steps go and the clouds keep their shape. The HRV's own red and green, which are sharp, are left alone here; once
 * the cloud mask is measured, sharpenHrv brings out their texture.
 */
import type { SatelliteChannel } from './satellite.config';

/**
 * The picture the sizes below are given for: the whole-India picture 2000 pixels across (1.5 km a pixel). Other pictures scale them by
 * `scale`, how many times finer their pixels are (a phone's whole-India picture is 0.5, a closer window about 2: see pictureScale),
 * so a blur always covers the same ground.
 */
export const REFERENCE_WIDTH = 2000;
/** Blur (pixels at the reference size) that takes the steps out of the infrared. */
export const GREY_SMOOTH_SIGMA = 1.4;

/** Normalised Gaussian weights, out to three sigma either side. */
export function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = w;
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return kernel;
}

/** Gaussian blur of a plane, in place (`scratch` is a plane of the same size). The edges repeat. */
export function blurPlane(plane: Float32Array, width: number, height: number, sigma: number, scratch = new Float32Array(plane.length)): void {
  const kernel = gaussianKernel(sigma);
  const taps = kernel.length;
  const r = (taps - 1) / 2;
  const row = new Float32Array(width + 2 * r);
  for (let y = 0; y < height; y++) {
    const o = y * width;
    row.set(plane.subarray(o, o + width), r);
    row.fill(plane[o], 0, r);
    row.fill(plane[o + width - 1], r + width);
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = 0; k < taps; k++) acc += kernel[k] * row[x + k];
      scratch[o + x] = acc;
    }
  }
  // down the columns a whole row at a time, so the reads stay in order
  for (let y = 0; y < height; y++) {
    const o = y * width;
    plane.fill(0, o, o + width);
    for (let k = 0; k < taps; k++) {
      const s = Math.min(Math.max(y + k - r, 0), height - 1) * width;
      const w = kernel[k];
      for (let x = 0; x < width; x++) plane[o + x] += w * scratch[s + x];
    }
  }
}

/** One channel of an RGBA picture as a plane. */
function channelPlane(px: Uint8ClampedArray, width: number, height: number, channel: number): Float32Array {
  const plane = new Float32Array(width * height);
  for (let i = 0, p = channel; i < plane.length; i++, p += 4) plane[i] = px[p];
  return plane;
}

/**
 * Takes the steps out of a grey picture (the infrared) with a Gaussian blur, in place; alpha is not touched. The picture's
 * pixels are 4-6 km wide, so a blur of about a third of that is what a smooth reading of them would be.
 */
export function smoothGrey(px: Uint8ClampedArray, width: number, height: number, sigma = GREY_SMOOTH_SIGMA * (width / REFERENCE_WIDTH)): void {
  const plane = channelPlane(px, width, height, 0);
  blurPlane(plane, width, height, sigma);
  for (let i = 0, p = 0; i < plane.length; i++, p += 4) px[p] = px[p + 1] = px[p + 2] = plane[i];
}

/** The same for one colour channel only (the infrared picture inside the HRV one is its blue). */
export function smoothChannel(px: Uint8ClampedArray, width: number, height: number, channel: number, sigma = GREY_SMOOTH_SIGMA * (width / REFERENCE_WIDTH)): void {
  const plane = channelPlane(px, width, height, channel);
  blurPlane(plane, width, height, sigma);
  for (let i = 0, p = channel; i < plane.length; i++, p += 4) px[p] = plane[i];
}

/**
 * Tidies the picture of a frame in place: the infrared loses its steps; the HRV picture keeps its sharp red and green and only its
 * infrared blue loses them. `scale`: how fine the picture's pixels are against the reference (the default suits a picture of all India).
 */
export function enhancePicture(px: Uint8ClampedArray, width: number, height: number, kind: SatelliteChannel, scale = width / REFERENCE_WIDTH): void {
  const sigma = GREY_SMOOTH_SIGMA * scale;
  if (kind === 'hrv') smoothChannel(px, width, height, 2, sigma);
  else smoothGrey(px, width, height, sigma);
}

/** Unsharp mask of the HRV's brightness: the blur (picture pixels) it is measured against, how much of the difference is added back, */
export const HRV_SHARPEN_SIGMA = 2;
export const HRV_SHARPEN_AMOUNT = 0.4;
/** differences smaller than this (0-255) are noise and JPEG residue, not detail, and are left alone, */
export const HRV_SHARPEN_THRESHOLD = 2;
/** and the most a pixel moves, so a bright cloud edge gets crisper without a halo. */
export const HRV_SHARPEN_MAX_STEP = 24;

/**
 * Brings out the texture of the clouds in an HRV picture (in place): the convective towers, cloud streets and the edges of anvils that the
 * satellite's 1.3 km pixel does see but that reprojection and magnification soften. An unsharp mask on the brightness (the mean of red and
 * green, the HRV itself), added equally to red and green so the colour does not shift; the blue (the infrared) and the empty edge are not
 * touched. `sigma` is in picture pixels: about two, so it brings out the shapes of the clouds and not single pixels, which a magnified
 * (HD) picture would show as squares; it acts before the picture is resampled.
 */
export function sharpenHrv(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  sigma = HRV_SHARPEN_SIGMA,
  amount = HRV_SHARPEN_AMOUNT,
  threshold = HRV_SHARPEN_THRESHOLD,
  maxStep = HRV_SHARPEN_MAX_STEP,
): void {
  const n = width * height;
  const lum = new Float32Array(n);
  // the blur is normalised by how much of the neighbourhood has data, so the empty edge of the picture does not read as a dark edge
  const blurred = new Float32Array(n);
  const valid = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    lum[i] = (px[p] + px[p + 1]) / 2;
    if (px[p] + px[p + 1] + px[p + 2] === 0) continue;
    blurred[i] = lum[i];
    valid[i] = 1;
  }
  const scratch = new Float32Array(n);
  blurPlane(blurred, width, height, sigma, scratch);
  blurPlane(valid, width, height, sigma, scratch);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (px[p] + px[p + 1] + px[p + 2] === 0) continue; // the empty edge stays empty
    const d = lum[i] - blurred[i] / valid[i];
    const cored = d > threshold ? d - threshold : d < -threshold ? d + threshold : 0;
    if (cored === 0) continue;
    const step = Math.max(-maxStep, Math.min(maxStep, amount * cored));
    px[p] += step;
    px[p + 1] += step;
  }
}
