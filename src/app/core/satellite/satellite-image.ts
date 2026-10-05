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
  out[o + 3] = view === 'picture' ? Math.round(255 * 0.92) : Math.round(255 * smoothstep(0.2, 0.55, luma) * 0.92);
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
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * outHeight * 4);
  const rowMap = mercatorRowMap(srcHeight, outHeight);
  const background = kind === 'hrv' ? hrvBackground(src) : 0;
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
