/**
 * Tidying of the satellite pictures, done in the worker on plain typed arrays (no image library).
 *
 * Everything on EUMETView except the high-resolution visible channel (HRV) is a 3 km sensor seen at a slant, so over India its
 * pixels are 4-6 km wide: on the finer grid of the picture they show as steps, and sharpening makes the steps stand out. The
 * infrared picture, and the infrared that sits in the blue channel of the HRV picture, are blurred a little (about a third of a
 * source pixel) so the steps go and the clouds keep their shape. The HRV's own red and green lose their noise (denoiseHrv), which a
 * magnified picture would show as a mottle.
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

/**
 * A Gaussian blur of a plane, approximated by three box blurs (in place; the edges repeat). Each box is a running sum, so the cost is the
 * same whatever `sigma`: for a wide blur of a big picture far cheaper than blurPlane, and as smooth to the eye.
 */
export function fastBlurPlane(plane: Float32Array, width: number, height: number, sigma: number): void {
  const r = Math.max(1, Math.round((Math.sqrt((12 * sigma * sigma) / 3 + 1) - 1) / 2));
  const norm = 1 / (2 * r + 1);
  const row = new Float32Array(width);
  const colSum = new Float64Array(width);
  const copy = new Float32Array(plane.length);
  for (let pass = 0; pass < 3; pass++) {
    // along each row
    for (let y = 0; y < height; y++) {
      const o = y * width;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += plane[o + Math.min(width - 1, Math.max(0, k))];
      for (let x = 0; x < width; x++) {
        row[x] = acc * norm;
        acc += plane[o + Math.min(width - 1, x + r + 1)] - plane[o + Math.max(0, x - r)];
      }
      plane.set(row, o);
    }
    // down the columns, a whole row at a time so the reads stay in order
    copy.set(plane);
    colSum.fill(0);
    for (let k = -r; k <= r; k++) {
      const o = Math.min(height - 1, Math.max(0, k)) * width;
      for (let x = 0; x < width; x++) colSum[x] += copy[o + x];
    }
    for (let y = 0; y < height; y++) {
      const o = y * width;
      const add = Math.min(height - 1, y + r + 1) * width;
      const sub = Math.max(0, y - r) * width;
      for (let x = 0; x < width; x++) {
        plane[o + x] = colSum[x] * norm;
        colSum[x] += copy[add + x] - copy[sub + x];
      }
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

/**
 * The blur (picture pixels, at the reference size of 1.5 km a pixel) that takes the noise out of the HRV's brightness: under a pixel, so
 * the cumulus keep their texture (the map's smooth magnification, see satellite-image.layer.ts, keeps a close zoom free of squares).
 * Detail finer than that is the sensor's noise, the JPEG's residue and, in a closer window, the pixels the service repeats where it is
 * asked for a little finer than the satellite sees (over South India its HRV pixel is wider than the 1.25 km asked for): magnified on
 * the map, all of these show as a mottle and a grid of soft squares. The clouds' own shapes are several pixels across and stay.
 */
export const HRV_DENOISE_SIGMA = 0.6;

/**
 * Takes the noise out of the HRV's brightness (red and green) in place: a Gaussian blur of their mean, each channel keeping its own
 * small difference from it so the colour does not shift; the blue (the infrared, smoothed by enhancePicture) and the empty edge are not
 * touched, and the blur is normalised by how much of the neighbourhood has data so the empty edge does not bleed in as a dark rim.
 */
export function denoiseHrv(px: Uint8ClampedArray, width: number, height: number, sigma = HRV_DENOISE_SIGMA): void {
  const n = width * height;
  const lum = new Float32Array(n);
  const valid = new Float32Array(n);
  let empty = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (px[p] + px[p + 1] + px[p + 2] === 0) {
      empty++;
      continue;
    }
    lum[i] = (px[p] + px[p + 1]) / 2;
    valid[i] = 1;
  }
  const blurred = Float32Array.from(lum);
  const scratch = new Float32Array(n);
  blurPlane(blurred, width, height, sigma, scratch);
  if (empty > 0) blurPlane(valid, width, height, sigma, scratch); // a picture with no empty edge (most) has nothing to normalise
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (px[p] + px[p + 1] + px[p + 2] === 0) continue; // the empty edge stays empty
    const step = (empty > 0 ? blurred[i] / valid[i] : blurred[i]) - lum[i];
    px[p] += step;
    px[p + 1] += step;
  }
}
