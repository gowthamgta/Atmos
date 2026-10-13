/**
 * Enhancement of the full satellite picture, done in the worker on plain typed arrays (no image library: the ones that could do
 * this are tens of megabytes, or make up detail the satellite never saw).
 *
 * Two things are wrong with the pictures as the service sends them, and both are the sensor's, not the map's:
 *  - Everything except the high-resolution visible channel (HRV) is a 3 km sensor seen at a slant, so over India its pixels are
 *    4-6 km wide. On the 1.6 km grid of the picture they show as steps, and sharpening makes the steps stand out.
 *  - The HRV picture is false colour (yellow land, violet sea) and has no data over a large part of the north and east.
 * So by day the picture is built the way satellite agencies make their sharpened true-colour images: the colour comes from the
 * natural-colour picture (green land, blue sea, white cloud; 3 km, so soft) and the fine detail from the HRV picture, which
 * sees 1 km (see `sharpenColourWithHrv`). The infrared and water-vapour pictures, which have no finer channel to borrow from,
 * only lose their steps (see `smoothGrey`). Nothing here is shown as a measurement: the hover readout and the thermal view
 * read the pictures before they are enhanced.
 */
import type { SatelliteChannel } from './satellite.config';

/**
 * The picture the sizes below are given for: the whole-India picture 2000 pixels across (1.5 km a pixel). Other pictures scale them by
 * `scale`, how many times finer their pixels are (a phone's whole-India picture is 0.5, a closer window about 2: see pictureScale),
 * so a blur always covers the same ground.
 */
export const REFERENCE_WIDTH = 2000;
/** Blur (pixels at the reference size) that takes the steps out of the infrared and water-vapour pictures. */
export const GREY_SMOOTH_SIGMA = 1.4;
/** The natural-colour picture's own blur (pixels of that picture, which is half the size of the main one at the reference size). */
export const COLOUR_SMOOTH_SIGMA = 0.8;
/** The visible picture is blurred this much (reference pixels) to the softness of the colour picture; what it has beyond that is the detail. */
export const DETAIL_SCALE_SIGMA = 2.4;
/** Brightness added to both sides of the detail ratio, so the dark sea's noise is not made into texture. */
export const DETAIL_OFFSET = 12;
/** The detail may brighten or darken the colour by this factor at most. */
export const DETAIL_MIN = 0.5;
export const DETAIL_MAX = 2;
/**
 * Where the natural-colour picture sits against the HRV one (reference pixels): about a pixel to the right and a pixel up. Five of six
 * pictures measured over one morning agreed to a quarter of a pixel; the sixth, the newest at that moment, was a pixel or two off and not
 * even the same everywhere, so the offset is measured on every picture and this is only for one too flat to measure.
 */
export const DEFAULT_SHIFT = { x: 0.9, y: -1.1 } as const;
/** How far (pixels of the coarse grid) the offset is searched, and how well the two pictures must agree for the result to be believed. */
export const SHIFT_RADIUS = 3;
export const MIN_SHIFT_SCORE = 0.35;
const MIN_TEXTURE = 1;

function smoothstep(lo: number, hi: number, v: number): number {
  const t = Math.min(Math.max((v - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
}

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

/** Box blur (a square `2r + 1` wide) of a plane in place, in a few steps per pixel however wide it is. The edges repeat. */
export function boxBlurPlane(plane: Float32Array, width: number, height: number, r: number, scratch = new Float32Array(plane.length)): void {
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < height; y++) {
    const o = y * width;
    let sum = (r + 1) * plane[o];
    for (let i = 1; i <= r; i++) sum += plane[o + Math.min(i, width - 1)];
    for (let x = 0; x < width; x++) {
      scratch[o + x] = sum * norm;
      sum += plane[o + Math.min(x + r + 1, width - 1)] - plane[o + Math.max(x - r, 0)];
    }
  }
  const col = new Float64Array(width); // doubles, so a long run of adding and taking away does not drift
  for (let x = 0; x < width; x++) col[x] = (r + 1) * scratch[x];
  for (let i = 1; i <= r; i++) {
    const o = Math.min(i, height - 1) * width;
    for (let x = 0; x < width; x++) col[x] += scratch[o + x];
  }
  for (let y = 0; y < height; y++) {
    const o = y * width;
    for (let x = 0; x < width; x++) plane[o + x] = col[x] * norm;
    const add = Math.min(y + r + 1, height - 1) * width;
    const sub = Math.max(y - r, 0) * width;
    for (let x = 0; x < width; x++) col[x] += scratch[add + x] - scratch[sub + x];
  }
}

/** One channel of an RGBA picture as a plane. */
function channelPlane(px: Uint8ClampedArray, width: number, height: number, channel: number): Float32Array {
  const plane = new Float32Array(width * height);
  for (let i = 0, p = channel; i < plane.length; i++, p += 4) plane[i] = px[p];
  return plane;
}

/**
 * Takes the steps out of a grey picture (infrared, water vapour) with a Gaussian blur, in place; alpha is not touched. The picture's
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

/** The texture of a plane without its brightness: a 3 x 3 average minus a 9 x 9 one. */
function bandPass(plane: Float32Array, width: number, height: number): Float32Array {
  const fine = Float32Array.from(plane);
  const coarse = Float32Array.from(plane);
  const scratch = new Float32Array(plane.length);
  boxBlurPlane(fine, width, height, 1, scratch);
  boxBlurPlane(coarse, width, height, 4, scratch);
  for (let i = 0; i < fine.length; i++) fine[i] -= coarse[i];
  return fine;
}

export interface PlaneShift {
  /** The shift (pixels): `b` moved right by `x` and down by `y` lies on `a`. */
  x: number;
  y: number;
  /** How well they agree there (correlation of their texture, 0..1). */
  score: number;
}

/** Offset of the top of a parabola through three equally spaced readings, relative to the middle one (at most half a step). */
function parabolaPeak(before: number, middle: number, after: number): number {
  const curve = before - 2 * middle + after;
  return curve < 0 ? Math.min(Math.max((0.5 * (before - after)) / curve, -0.5), 0.5) : 0;
}

/**
 * Where `b` lies against `a`. Only the texture of the two planes is compared (band-passed, so their different brightness and
 * contrast do not matter), at whole-pixel moves of up to `radius`; the best is refined with a parabola through its neighbours. `valid`
 * marks where `a` is real data. Gives null when there is too little texture to tell, the best agreement is poor, or the best move is
 * at the end of the search (the true one lies beyond it).
 */
export function estimateShift(
  a: Float32Array,
  b: Float32Array,
  valid: ArrayLike<number>,
  width: number,
  height: number,
  radius = SHIFT_RADIUS,
): PlaneShift | null {
  const margin = radius + 6;
  if (width < 2 * margin + 16 || height < 2 * margin + 16) return null;
  const pa = bandPass(a, width, height);
  const pb = bandPass(b, width, height);
  // every third pixel where `a` is real, away from the edges
  const samples = new Int32Array(Math.ceil((width - 2 * margin) / 3) * Math.ceil((height - 2 * margin) / 3));
  let count = 0;
  let aa = 0;
  for (let y = margin; y < height - margin; y += 3) {
    for (let x = margin; x < width - margin; x += 3) {
      const i = y * width + x;
      if (!valid[i]) continue;
      samples[count++] = i;
      aa += pa[i] * pa[i];
    }
  }
  if (count < 400 || Math.sqrt(aa / count) < MIN_TEXTURE) return null;
  const side = 2 * radius + 1;
  const score = new Float64Array(side * side);
  let best = -2;
  let bx = 0;
  let by = 0;
  for (let sy = -radius; sy <= radius; sy++) {
    for (let sx = -radius; sx <= radius; sx++) {
      const offset = -sy * width - sx; // b(x - sx, y - sy)
      let ab = 0;
      let bb = 0;
      for (let n = 0; n < count; n++) {
        const v = pb[samples[n] + offset];
        ab += pa[samples[n]] * v;
        bb += v * v;
      }
      const c = ab / Math.sqrt(aa * bb + 1e-9);
      score[(sy + radius) * side + sx + radius] = c;
      if (c > best) {
        best = c;
        bx = sx;
        by = sy;
      }
    }
  }
  if (best < MIN_SHIFT_SCORE || Math.abs(bx) === radius || Math.abs(by) === radius) return null;
  const at = (sx: number, sy: number) => score[(sy + radius) * side + sx + radius];
  return {
    x: bx + parabolaPeak(at(bx - 1, by), best, at(bx + 1, by)),
    y: by + parabolaPeak(at(bx, by - 1), best, at(bx, by + 1)),
    score: best,
  };
}

export interface FusionInfo {
  /** Where the colour picture was found against the HRV one (pixels of the main picture), and whether it was measured or the usual value. */
  shiftX: number;
  shiftY: number;
  measured: boolean;
}

/**
 * For each of `count` positions along a line, the two source pixels (of a line `size` pixels long) a bilinear read there takes and the
 * weight of the second. `position(i)` is the place to read in source pixels, pixel centres on whole numbers; the ends repeat.
 */
function tapTable(count: number, size: number, position: (i: number) => number): { lo: Int32Array; hi: Int32Array; frac: Float32Array } {
  const lo = new Int32Array(count);
  const hi = new Int32Array(count);
  const frac = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const p = position(i);
    const f = Math.floor(p);
    lo[i] = Math.min(Math.max(f, 0), size - 1);
    hi[i] = Math.min(Math.max(f + 1, 0), size - 1);
    frac[i] = p - f;
  }
  return { lo, hi, frac };
}

/**
 * Sharpens the natural-colour picture with the HRV one, in place in `hrv` (an RGBA picture whose red and green are the HRV, and
 * blue the infrared; it comes out as the colour picture with the HRV's detail, with alpha untouched). `colour` is the natural-colour
 * picture at its own size (usually half of the main one), already free of JPEG blocks. `scale` is how fine the pixels are against the
 * reference picture (see REFERENCE_WIDTH); the default is right for a picture covering all India.
 *
 * Standard sharpening of a colour picture by a finer grey one, in four steps:
 *  1. the colour picture is blurred a little, to take out its source's pixel steps, and moved onto the HRV picture (the two are
 *     a pixel or so out of line, which would otherwise put a coloured fringe along every coast and cloud edge);
 *  2. the HRV picture is blurred to the softness of the colour picture;
 *  3. at each pixel the HRV's brightness is divided by that blurred brightness: above 1 where the HRV sees a brighter speck than
 *     the colour picture can, below 1 where it sees a darker one;
 *  4. the colour is multiplied by that ratio, so its hue is kept and only the detail is added.
 * Where the HRV has no data the colour picture is left as it is, so the north and east do not turn violet; the detail fades in over
 * a few pixels at the edge of the HRV's data so there is no seam.
 */
export function sharpenColourWithHrv(
  hrv: Uint8ClampedArray,
  width: number,
  height: number,
  colour: Uint8ClampedArray,
  cw: number,
  ch: number,
  scale = width / REFERENCE_WIDTH,
): FusionInfo {
  const step = Math.max(1, Math.round(width / cw));
  const dw = Math.floor(width / step);
  const dh = Math.floor(height / step);

  // 1. the colour picture, smoothed and as interleaved planes (red, green, blue per pixel), and its brightness
  const soft = new Float32Array(cw * ch * 3);
  const lumaColour = new Float32Array(cw * ch);
  {
    const sigma = COLOUR_SMOOTH_SIGMA * scale * ((2 * cw) / width); // the usual colour picture is half the size of the main one
    const scratch = new Float32Array(cw * ch);
    const planes = [0, 1, 2].map(c => {
      const plane = channelPlane(colour, cw, ch, c);
      blurPlane(plane, cw, ch, sigma, scratch);
      return plane;
    });
    for (let i = 0; i < cw * ch; i++) {
      soft[i * 3] = planes[0][i];
      soft[i * 3 + 1] = planes[1][i];
      soft[i * 3 + 2] = planes[2][i];
      lumaColour[i] = 0.3 * planes[0][i] + 0.59 * planes[1][i] + 0.11 * planes[2][i];
    }
  }

  // the HRV's brightness on the coarse grid (and where every pixel of a cell has data)
  const hd = new Float32Array(dw * dh);
  const real = new Float32Array(dw * dh);
  const cell = step * step;
  for (let j = 0; j < dh; j++) {
    for (let i = 0; i < dw; i++) {
      let sum = 0;
      let n = 0;
      for (let y = j * step; y < (j + 1) * step; y++) {
        let p = (y * width + i * step) * 4;
        for (let x = 0; x < step; x++, p += 4) {
          const s = hrv[p] + hrv[p + 1];
          sum += s;
          if (s >= 3) n++;
        }
      }
      if (n === cell) {
        hd[j * dw + i] = sum / (2 * cell);
        real[j * dw + i] = 1;
      }
    }
  }

  // the colour picture's brightness on the same grid, to measure how the two lie against each other
  const colourOnGrid = new Float32Array(dw * dh);
  {
    const tu = tapTable(dw, cw, i => ((i + 0.5) * step * cw) / width - 0.5);
    const tv = tapTable(dh, ch, j => ((j + 0.5) * step * ch) / height - 0.5);
    for (let j = 0; j < dh; j++) {
      const r0 = tv.lo[j] * cw;
      const r1 = tv.hi[j] * cw;
      const fv = tv.frac[j];
      for (let i = 0; i < dw; i++) {
        const fu = tu.frac[i];
        colourOnGrid[j * dw + i] =
          (lumaColour[r0 + tu.lo[i]] * (1 - fu) + lumaColour[r0 + tu.hi[i]] * fu) * (1 - fv) +
          (lumaColour[r1 + tu.lo[i]] * (1 - fu) + lumaColour[r1 + tu.hi[i]] * fu) * fv;
      }
    }
  }
  const found = estimateShift(hd, colourOnGrid, real, dw, dh);
  const shiftX = found ? found.x * step : DEFAULT_SHIFT.x * scale;
  const shiftY = found ? found.y * step : DEFAULT_SHIFT.y * scale;

  // 2. the HRV blurred to the colour picture's softness (blurring the data and the "has data" plane alike, so the edge of the data does not darken it)
  const sigmaCoarse = (DETAIL_SCALE_SIGMA * scale) / step;
  const num = new Float32Array(dw * dh);
  for (let i = 0; i < num.length; i++) num[i] = hd[i] * real[i];
  const scratch = new Float32Array(dw * dh);
  blurPlane(num, dw, dh, sigmaCoarse, scratch);
  blurPlane(real, dw, dh, sigmaCoarse, scratch);
  const lowPass = new Float32Array(dw * dh);
  const weight = new Float32Array(dw * dh);
  for (let i = 0; i < lowPass.length; i++) {
    lowPass[i] = real[i] > 1e-3 ? num[i] / real[i] : 0;
    weight[i] = smoothstep(0.35, 0.9, real[i]);
  }

  // 3 and 4. the ratio of detail to its blur, multiplied into the colour picture moved onto the HRV
  const cu = tapTable(width, cw, x => ((x + 0.5 - shiftX) * cw) / width - 0.5);
  const cv = tapTable(height, ch, y => ((y + 0.5 - shiftY) * ch) / height - 0.5);
  const gu = tapTable(width, dw, x => (x + 0.5) / step - 0.5);
  const gv = tapTable(height, dh, y => (y + 0.5) / step - 0.5);
  for (let y = 0; y < height; y++) {
    const c0 = cv.lo[y] * cw;
    const c1 = cv.hi[y] * cw;
    const fv = cv.frac[y];
    const g0 = gv.lo[y] * dw;
    const g1 = gv.hi[y] * dw;
    const gf = gv.frac[y];
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const fu = cu.frac[x];
      const w00 = (1 - fu) * (1 - fv);
      const w10 = fu * (1 - fv);
      const w01 = (1 - fu) * fv;
      const w11 = fu * fv;
      const a = (c0 + cu.lo[x]) * 3;
      const b = (c0 + cu.hi[x]) * 3;
      const c = (c1 + cu.lo[x]) * 3;
      const d = (c1 + cu.hi[x]) * 3;
      const nr = soft[a] * w00 + soft[b] * w10 + soft[c] * w01 + soft[d] * w11;
      const ng = soft[a + 1] * w00 + soft[b + 1] * w10 + soft[c + 1] * w01 + soft[d + 1] * w11;
      const nb = soft[a + 2] * w00 + soft[b + 2] * w10 + soft[c + 2] * w01 + soft[d + 2] * w11;
      if (nr + ng + nb < 1) {
        hrv[p] = hrv[p + 1] = hrv[p + 2] = 0; // no data in the colour picture either: stays empty
        continue;
      }
      let gain = 1;
      const s = hrv[p] + hrv[p + 1];
      if (s >= 3) {
        const hf = gu.frac[x];
        const q00 = (1 - hf) * (1 - gf);
        const q10 = hf * (1 - gf);
        const q01 = (1 - hf) * gf;
        const q11 = hf * gf;
        const i0 = g0 + gu.lo[x];
        const i1 = g0 + gu.hi[x];
        const i2 = g1 + gu.lo[x];
        const i3 = g1 + gu.hi[x];
        const blur = lowPass[i0] * q00 + lowPass[i1] * q10 + lowPass[i2] * q01 + lowPass[i3] * q11;
        const share = weight[i0] * q00 + weight[i1] * q10 + weight[i2] * q01 + weight[i3] * q11;
        const ratio = Math.min(Math.max((s * 0.5 + DETAIL_OFFSET) / (blur + DETAIL_OFFSET), DETAIL_MIN), DETAIL_MAX);
        gain = 1 + (ratio - 1) * share;
      }
      // never exactly black: black means "no data" to the overlay
      hrv[p] = Math.max(1, nr * gain);
      hrv[p + 1] = Math.max(1, ng * gain);
      hrv[p + 2] = Math.max(1, nb * gain);
    }
  }
  return { shiftX, shiftY, measured: found !== null };
}

/** The natural-colour picture as it is decoded: its pixels and its own size. */
export interface ColourPicture {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Enhances the full picture of a frame in place: the HRV picture gets the natural colours and the detail of the HRV (or, when the
 * colour picture could not be fetched, only its infrared blue cleared of steps); infrared and water vapour lose their steps.
 * `scale`: how fine the picture's pixels are against the reference (the default suits a picture of all India).
 */
export function enhancePicture(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  kind: SatelliteChannel,
  colour?: ColourPicture,
  scale = width / REFERENCE_WIDTH,
): void {
  if (kind !== 'hrv') {
    smoothGrey(px, width, height, GREY_SMOOTH_SIGMA * scale);
  } else if (colour) {
    sharpenColourWithHrv(px, width, height, colour.data, colour.width, colour.height, scale);
  } else {
    smoothChannel(px, width, height, 2, GREY_SMOOTH_SIGMA * scale);
  }
}
