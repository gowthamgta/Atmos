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
  if (kind === 'hrv' || kind === 'rgb') {
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
  // true black is no data (FY-4B does not reach the far south of the domain): see-through
  out[o + 3] = r + g + b === 0 ? 0 : view === 'picture' ? Math.round(255 * 0.92) : Math.round(255 * smoothstep(0.2, 0.55, luma) * 0.92);
}

/**
 * How much cloud there is at each pixel (0 none .. 1 thick), from the satellite picture.
 *
 * HRV picture: cloud is white or lavender, so its blue channel is high compared with the typical land and sea (the
 * `background`), and unlike bright, sunlit land (yellow: blue far below red and green) its blue is close to its red and
 * green. Both must hold, which keeps the bright land speckle out. Infrared: cold, high cloud is bright.
 */
export function cloudCover(src: Uint8ClampedArray, width: number, height: number, kind: SatelliteChannel, background: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = src[p];
    const g = src[p + 1];
    const b = src[p + 2];
    if (kind === 'rgb') {
      // true colour: cloud is bright in every channel, land and sea are not (red is low over both)
      out[i] = smoothstep(0.34, 0.68, Math.min(r, g, b) / 255);
    } else if (kind === 'hrv') {
      const ratio = b / Math.max(1, (r + g) / 2); // about 0.4 on yellow land, 0.8 and more in cloud
      out[i] = smoothstep(background + 15, background + 100, b) * smoothstep(0.55, 0.78, ratio);
    } else {
      out[i] = smoothstep(0.2, 0.55, (r + g + b) / 3 / 255);
    }
  }
  return out;
}

/** Gaussian blur of a `width` x `height` field (separable, edges clamped), sigma in pixels. */
export function blurField(field: Float32Array, width: number, height: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += (kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma)));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float32Array(field.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += field[row + Math.min(width - 1, Math.max(0, x + k))] * kernel[k + radius];
      tmp[row + x] = acc;
    }
  }
  const out = new Float32Array(field.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += tmp[Math.min(height - 1, Math.max(0, y + k)) * width + x] * kernel[k + radius];
      out[y * width + x] = acc;
    }
  }
  return out;
}

/**
 * Cloud look: how far the cloud is smoothed (picture pixels), how see-through it stays, how much of the natural-colour
 * picture is blended into the HRV colours, and how much the colour is muted.
 */
export const CLOUD_SIGMA = 4;
export const CLOUD_ALPHA = 0.72;
export const NATURAL_SHARE = 0.25;
export const CLOUD_MUTE = 0.2;
export const CLOUD_TONE = 0.95;
/** Night (infrared) cloud tones, from thin and warm to thick and cold. */
export const IR_THIN: readonly [number, number, number] = [120, 132, 160];
export const IR_THICK: readonly [number, number, number] = [238, 242, 250];

/**
 * Cloud only, as a smooth translucent veil over the map (the look of Windy's satellite layer). The cloud keeps its own
 * colours: by day the HRV picture's (cream low cloud, blue-white high cloud), blended with a share of the natural-colour
 * picture when there is one; at night grey-blue to white by how cold the cloud is. Colour and cover are blurred together
 * (premultiplied) about as wide as a satellite pixel, so no pixel or hard edge shows, and the veil never hides the map
 * completely. `natural`, when given, is the natural-colour picture of the same size. Returns straight RGBA.
 */
export function shadeCloudLayer(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  kind: SatelliteChannel,
  background: number,
  natural?: Uint8ClampedArray,
): Uint8ClampedArray<ArrayBuffer> {
  const cover = cloudCover(src, width, height, kind, background);
  const n = cover.length;
  const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const c = cover[i];
    if (c <= 0) continue;
    if (kind === 'ir') {
      const t = (src[p] + src[p + 1] + src[p + 2]) / 765;
      for (let k = 0; k < 3; k++) planes[k][i] = c * (IR_THIN[k] + (IR_THICK[k] - IR_THIN[k]) * t);
    } else {
      for (let k = 0; k < 3; k++) {
        const own = src[p + k];
        planes[k][i] = c * (natural ? own * (1 - NATURAL_SHARE) + natural[p + k] * NATURAL_SHARE : own);
      }
    }
  }
  const mask = blurField(cover, width, height, CLOUD_SIGMA);
  const blurred = planes.map(pl => blurField(pl, width, height, CLOUD_SIGMA));
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = smoothstep(0.02, 0.95, mask[i]);
    if (a <= 0) continue;
    const m = Math.max(mask[i], 1e-3);
    const r = blurred[0][i] / m;
    const g = blurred[1][i] / m;
    const b = blurred[2][i] / m;
    const grey = (r + g + b) / 3;
    out[p] = (r + (grey - r) * CLOUD_MUTE) * CLOUD_TONE;
    out[p + 1] = (g + (grey - g) * CLOUD_MUTE) * CLOUD_TONE;
    out[p + 2] = (b + (grey - b) * CLOUD_MUTE) * CLOUD_TONE;
    out[p + 3] = 255 * a * CLOUD_ALPHA;
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
