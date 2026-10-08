/**
 * Pure pixel maths for turning an EUMETView picture into a map overlay.
 *
 * The service returns plain latitude/longitude pictures, but the map is Mercator, where each degree of latitude is
 * taller than the last one going north. So the picture's rows are re-spaced to Mercator before it is placed on the
 * map, and its dark or empty parts are made see-through.
 */
import { SATELLITE_BOUNDS, SatelliteChannel, SatelliteView } from './satellite.config';

const RAD = Math.PI / 180;

export function mercatorY(latDeg: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (latDeg * RAD) / 2));
}

export function latFromMercatorY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;
}

/** Output height that keeps square pixels on the Mercator map for a picture `width` pixels wide. */
export function mercatorHeight(width: number, b = SATELLITE_BOUNDS): number {
  const lonSpan = (b.east - b.west) * RAD;
  return Math.round((width * (mercatorY(b.north) - mercatorY(b.south))) / lonSpan);
}

/**
 * For each output row (top to bottom, evenly spaced in Mercator), the fractional row of the source picture
 * (top to bottom, evenly spaced in latitude) that it should show.
 */
export function mercatorRowMap(srcHeight: number, outHeight: number, b = SATELLITE_BOUNDS): Float32Array {
  const yTop = mercatorY(b.north);
  const yBottom = mercatorY(b.south);
  const rows = new Float32Array(outHeight);
  for (let r = 0; r < outHeight; r++) {
    const lat = latFromMercatorY(yTop + ((yBottom - yTop) * (r + 0.5)) / outHeight);
    const f = ((b.north - lat) / (b.north - b.south)) * srcHeight - 0.5;
    rows[r] = Math.min(Math.max(f, 0), srcHeight - 1);
  }
  return rows;
}

function smoothstep(lo: number, hi: number, v: number): number {
  const t = Math.min(Math.max((v - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Side of a JPEG block, and the biggest step (0-255 per channel) across a block edge that is treated as compression, not cloud. */
export const JPEG_BLOCK = 8;
export const DEBLOCK_MAX_STEP = 20;

/**
 * Smooths the faint steps JPEG compression leaves at the 8 x 8 block edges of an RGBA picture (in place; alpha is not
 * touched). Across each block edge the two pixels either side move towards each other, and their outer neighbours a
 * little, but only where the step is small. Real cloud edges (bigger steps) are left alone. Without this, sharpening
 * the picture at deep zoom would bring out the block grid.
 */
export function deblockJpeg(px: Uint8ClampedArray, width: number, height: number, maxStep = DEBLOCK_MAX_STEP): void {
  const stride = width * 4;
  const smooth = (i: number, step: number): void => {
    // i: index of the first pixel after the edge; step: distance in the array between neighbouring pixels across it
    for (let c = 0; c < 3; c++) {
      const a = px[i - step + c];
      const b = px[i + c];
      const d = b - a;
      if (d === 0 || Math.abs(d) > maxStep) continue;
      px[i - 2 * step + c] += 0.15 * d;
      px[i - step + c] = a + 0.35 * d;
      px[i + c] = b - 0.35 * d;
      px[i + step + c] -= 0.15 * d;
    }
  };
  for (let y = 0; y < height; y++) {
    for (let x = JPEG_BLOCK; x < width - 1; x += JPEG_BLOCK) smooth(y * stride + x * 4, 4);
  }
  for (let y = JPEG_BLOCK; y < height - 1; y += JPEG_BLOCK) {
    for (let x = 0; x < width; x++) smooth(y * stride + x * 4, stride);
  }
}

/**
 * The typical brightness of land and sea in the blue channel of an HRV picture: its median. Cloud covers well under
 * half of the area, so the median is the background, whatever the sun's height (it is low at dawn and dusk).
 */
export function hrvBackground(src: Uint8ClampedArray): number {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 2; i < src.length; i += 4 * 7) { // every 7th pixel is plenty
    if (src[i - 2] + src[i - 1] + src[i] < 12) continue; // empty corners are not background
    hist[src[i]]++;
    n++;
  }
  if (n === 0) return 60; // nothing to measure (an all-black picture): use a typical value
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= n / 2) return v;
  }
  return 60;
}

/**
 * Colour and opacity (0..255) of one pixel; the result is written into `out` at `o`.
 *
 * HRV pictures show land yellow, sea dark and cloud white or lavender, so cloud stands out in the blue channel.
 * In `clouds` view the opacity follows how far the blue channel is above the background, and the cloud is drawn white;
 * in `picture` view everything except true black is kept. Infrared is grey and bright where the cloud is cold and high.
 */
export function shadePixel(
  kind: SatelliteChannel,
  view: SatelliteView,
  r: number,
  g: number,
  b: number,
  background: number,
  out: Uint8ClampedArray,
  o: number,
): void {
  if (kind === 'hrv') {
    if (view === 'picture') {
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
      out[o + 3] = Math.round(255 * smoothstep(3, 14, Math.max(r, g, b)));
      return;
    }
    const cloud = smoothstep(background + 20, background + 105, b);
    const white = Math.min(255, 0.55 * g + 0.45 * b + 28 * cloud); // slightly brightened, so thin cloud reads clearly
    out[o] = white; out[o + 1] = white; out[o + 2] = Math.min(255, white + 8);
    out[o + 3] = Math.round(255 * Math.pow(cloud, 0.85) * 0.96);
    return;
  }
  const luma = (r + g + b) / 3 / 255;
  out[o] = r; out[o + 1] = g; out[o + 2] = b;
  // true black is no data (at the edge of the picture): see-through
  out[o + 3] = r + g + b === 0 ? 0 : view === 'picture' ? Math.round(255 * 0.92) : Math.round(255 * smoothstep(0.2, 0.55, luma) * 0.92);
}

/**
 * How much cloud there is at each pixel (0 none .. 1 thick), from the satellite picture.
 *
 * HRV picture: two kinds of cloud. Middle and high cloud is cold, so its blue channel (the inverted infrared) is high,
 * well above the land and sea and close to its red and green. Low cloud is warm, so it is yellow like the land, only much
 * brighter; where the natural-colour picture is given (`naturalWhite`: how white it is, 0..1, per pixel), low cloud is
 * where that picture is white and the HRV is bright, otherwise only very bright yellow counts (sunlit land stays out).
 *
 * HRV picture: cloud is white or lavender, so its blue channel is high compared with the typical land and sea (the
 * `background`), and unlike bright, sunlit land (yellow: blue far below red and green) its blue is close to its red and
 * green. Both must hold, which keeps the bright land speckle out. Infrared: cold, high cloud is bright.
 */
export function cloudCover(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  kind: SatelliteChannel,
  background: number,
  naturalWhite?: Float32Array,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = src[p];
    const g = src[p + 1];
    const b = src[p + 2];
    if (kind === 'hrv') {
      const hrv = (r + g) / 2;
      const ratio = b / Math.max(1, hrv); // about 0.4 on yellow land, 0.8 and more in cold cloud
      const cold = smoothstep(background + 15, background + 100, b) * smoothstep(0.55, 0.78, ratio);
      const low = naturalWhite ? naturalWhite[i] * smoothstep(70, 150, hrv) : smoothstep(175, 230, hrv);
      out[i] = Math.max(cold, low);
    } else {
      out[i] = smoothstep(0.2, 0.55, (r + g + b) / 3 / 255);
    }
  }
  return out;
}

/**
 * Gaussian blur of a `width` x `height` field (separable, edges clamped), sigma in pixels.
 *
 * The horizontal pass copies each row into a padded buffer once (so the taps need no clamping) and pairs the symmetric
 * taps; the vertical pass adds whole rows (sequential memory, not column by column). Same result as the plain
 * convolution up to float rounding, about three times faster, which matters for the several blurs of every satellite frame.
 */
export function blurField(field: Float32Array, width: number, height: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += (kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma)));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  // horizontal: row by row through a padded copy, one tap at a time over the whole row (streams through memory)
  const tmp = new Float32Array(field.length);
  const padded = new Float32Array(width + 2 * radius);
  const rowAcc = new Float64Array(width);
  const centre = kernel[radius];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const first = field[row];
    const last = field[row + width - 1];
    for (let i = 0; i < radius; i++) {
      padded[i] = first;
      padded[radius + width + i] = last;
    }
    padded.set(field.subarray(row, row + width), radius);
    for (let x = 0; x < width; x++) rowAcc[x] = centre * padded[radius + x];
    for (let j = 1; j <= radius; j++) {
      const k = kernel[radius + j];
      const lo = radius - j;
      const hi = radius + j;
      for (let x = 0; x < width; x++) rowAcc[x] += k * (padded[lo + x] + padded[hi + x]);
    }
    for (let x = 0; x < width; x++) tmp[row + x] = rowAcc[x];
  }

  // vertical: each output row is the weighted sum of whole rows
  const out = new Float32Array(field.length);
  const acc = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    acc.fill(0);
    for (let t = -radius; t <= radius; t++) {
      const yy = Math.min(height - 1, Math.max(0, y + t)) * width;
      const k = kernel[t + radius];
      for (let x = 0; x < width; x++) acc[x] += k * tmp[yy + x];
    }
    const o = y * width;
    for (let x = 0; x < width; x++) out[o + x] = acc[x];
  }
  return out;
}

/**
 * The same blur for wide sigmas, at half resolution: the field is averaged 2 x 2, blurred with half the sigma and enlarged
 * again (bilinear). A gaussian that wide leaves nothing finer than a few pixels, so this differs from `blurField` by a
 * fraction of a percent while touching a quarter of the pixels. Narrow blurs are done exactly.
 */
export function blurFieldWide(field: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (sigma < 2 || width < 8 || height < 8) return blurField(field, width, height, sigma);
  const hw = width >> 1;
  const hh = height >> 1;
  const small = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    const a = 2 * y * width;
    const b = a + width;
    for (let x = 0; x < hw; x++) {
      const i = 2 * x;
      small[y * hw + x] = 0.25 * (field[a + i] + field[a + i + 1] + field[b + i] + field[b + i + 1]);
    }
  }
  const blurred = blurField(small, hw, hh, sigma / 2);
  const out = new Float32Array(field.length);
  for (let y = 0; y < height; y++) {
    // the centre of full-resolution pixel y in half-resolution coordinates
    const fy = Math.min(Math.max((y + 0.5) / 2 - 0.5, 0), hh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, hh - 1);
    const wy = fy - y0;
    const r0 = y0 * hw;
    const r1 = y1 * hw;
    const o = y * width;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(Math.max((x + 0.5) / 2 - 0.5, 0), hw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, hw - 1);
      const wx = fx - x0;
      out[o + x] = (blurred[r0 + x0] * (1 - wx) + blurred[r0 + x1] * wx) * (1 - wy) + (blurred[r1 + x0] * (1 - wx) + blurred[r1 + x1] * wx) * wy;
    }
  }
  return out;
}

/** Cloud-only view: the blur (picture pixels) of the cloud outline when picking, the smoothing of the picked cloud, and its opacity. */
export const CLOUD_EDGE_SIGMA = 0.7;
export const CLOUD_SMOOTH_SIGMA = 2.5;   // 0: the picked cloud keeps the picture's own pixels; about 2.5 hides the satellite's pixels
export const CLOUD_ALPHA = 0.95;
/**
 * After the smoothing the cloud's texture is put back (the brightness minus a wider blur of itself, so the bright cores and
 * darker folds return while the pixel blocks stay gone), the colour gets a little more saturation, and the cloud a little
 * more brightness and opacity. 0 turns the texture off.
 */
export const CLOUD_TEXTURE = 1.0;
export const CLOUD_TEXTURE_SCALE = 2.2;     // the texture's blur is this many times the smoothing's
export const CLOUD_TEXTURE_GAIN = 1.1;
export const CLOUD_SATURATION = 0.25;
export const CLOUD_GAIN = 1.06;
export const CLOUD_OPACITY_BOOST = 1.1;
/** How the natural-colour picture's whiteness is read (0..1 of its darkest channel) and smoothed (its pixels are 3 km). */
export const NATURAL_WHITE: readonly [number, number] = [0.3, 0.58];
export const NATURAL_SIGMA = 1.5;

/**
 * Cloud only: first the cloud is picked out of the picture, pixel by pixel (the picture's own colours, the land and sea
 * cleared); then only the picked cloud is smoothed, colour and opacity together (premultiplied, so no dark fringe), which
 * hides the satellite's pixels the way Windy's layer does, and its texture is put back (see CLOUD_TEXTURE). The colour
 * code stays (HRV: yellow low cloud, white and blue-white middle and high cloud). `natural`, when given, is the natural-colour picture of the same size; it is used
 * only to find low cloud. Returns straight RGBA of the same size.
 */
export function shadeCloudLayer(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  kind: SatelliteChannel,
  background: number,
  natural?: Uint8ClampedArray,
): Uint8ClampedArray<ArrayBuffer> {
  let white: Float32Array | undefined;
  if (natural && kind === 'hrv') {
    white = new Float32Array(width * height);
    for (let i = 0, p = 0; i < white.length; i++, p += 4) {
      white[i] = smoothstep(NATURAL_WHITE[0], NATURAL_WHITE[1], Math.min(natural[p], natural[p + 1], natural[p + 2]) / 255);
    }
    white = blurField(white, width, height, NATURAL_SIGMA);
  }
  const cover = blurField(cloudCover(src, width, height, kind, background, white), width, height, CLOUD_EDGE_SIGMA);
  // pick: the cloud's own colour, weighted by how sure it is cloud
  const n = cover.length;
  const alpha = new Float32Array(n);
  const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = smoothstep(0.08, 0.7, cover[i]);
    if (a <= 0) continue;
    alpha[i] = a;
    planes[0][i] = src[p] * a;
    planes[1][i] = src[p + 1] * a;
    planes[2][i] = src[p + 2] * a;
  }
  // smooth: the picked cloud only, colour and opacity together
  const smooth = (f: Float32Array) => (CLOUD_SMOOTH_SIGMA > 0 ? blurFieldWide(f, width, height, CLOUD_SMOOTH_SIGMA) : f);
  const softAlpha = smooth(alpha);
  const soft = planes.map(smooth);
  // the cloud's own colour (not weighted by its opacity) and brightness, then the texture, saturation and gain
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = softAlpha[i];
    if (a < 0.01) continue;
    soft[0][i] /= a;
    soft[1][i] /= a;
    soft[2][i] /= a;
    lum[i] = (soft[0][i] + soft[1][i] + soft[2][i]) / 3;
  }
  const enhance = CLOUD_TEXTURE > 0 && CLOUD_SMOOTH_SIGMA > 0;
  const wide = enhance ? blurFieldWide(lum, width, height, CLOUD_SMOOTH_SIGMA * CLOUD_TEXTURE_SCALE) : lum;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let a = softAlpha[i];
    if (a < 0.01) continue;
    let r = soft[0][i];
    let g = soft[1][i];
    let b = soft[2][i];
    if (enhance) {
      const local = CLOUD_TEXTURE * CLOUD_TEXTURE_GAIN * (lum[i] - wide[i]);
      r += local; g += local; b += local;
      const grey = (r + g + b) / 3;
      r = (grey + (r - grey) * (1 + CLOUD_SATURATION)) * CLOUD_GAIN;
      g = (grey + (g - grey) * (1 + CLOUD_SATURATION)) * CLOUD_GAIN;
      b = (grey + (b - grey) * (1 + CLOUD_SATURATION)) * CLOUD_GAIN;
      a *= CLOUD_OPACITY_BOOST;
    }
    out[p] = r;
    out[p + 1] = g;
    out[p + 2] = b;
    out[p + 3] = 255 * Math.min(1, a) * CLOUD_ALPHA;
  }
  return out;
}

/**
 * Re-space the rows of an RGBA picture to Mercator (linear blend between the two nearest source rows) and set colour and
 * opacity for the chosen view. `src` is `width` x `srcHeight`; the result is `width` x `outHeight`.
 */
export function toOverlayPixels(
  src: Uint8ClampedArray,
  width: number,
  srcHeight: number,
  kind: SatelliteChannel,
  view: SatelliteView,
  outHeight = mercatorHeight(width),
  natural?: Uint8ClampedArray,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * outHeight * 4);
  const rowMap = mercatorRowMap(srcHeight, outHeight);
  const background = kind === 'hrv' ? hrvBackground(src) : 0;
  // Clouds only: shade the clouds at the picture's own resolution first, then re-space the rows (premultiplied, so
  // the soft cloud edges blend without fringes). Other views shade each re-spaced pixel.
  const clouds = view === 'clouds' ? shadeCloudLayer(src, width, srcHeight, kind, background, natural) : null;
  for (let r = 0; r < outHeight; r++) {
    const f = rowMap[r];
    const y0 = Math.floor(f);
    const y1 = Math.min(y0 + 1, srcHeight - 1);
    const w = f - y0;
    const a = y0 * width * 4;
    const c = y1 * width * 4;
    let o = r * width * 4;
    for (let x = 0; x < width; x++, o += 4) {
      const i = x * 4;
      if (clouds) {
        const aA = clouds[a + i + 3] / 255;
        const aB = clouds[c + i + 3] / 255;
        const alpha = aA * (1 - w) + aB * w;
        if (alpha <= 0) continue;
        for (let k = 0; k < 3; k++) out[o + k] = (clouds[a + i + k] * aA * (1 - w) + clouds[c + i + k] * aB * w) / alpha;
        out[o + 3] = alpha * 255;
        continue;
      }
      shadePixel(
        kind, view,
        src[a + i] * (1 - w) + src[c + i] * w,
        src[a + i + 1] * (1 - w) + src[c + i + 1] * w,
        src[a + i + 2] * (1 - w) + src[c + i + 2] * w,
        background, out, o,
      );
    }
  }
  return out;
}

/** The overlay's corners for MapLibre: top-left, top-right, bottom-right, bottom-left as [lng, lat]. */
export function satelliteCoordinates(b = SATELLITE_BOUNDS): [[number, number], [number, number], [number, number], [number, number]] {
  return [
    [b.west, b.north],
    [b.east, b.north],
    [b.east, b.south],
    [b.west, b.south],
  ];
}
