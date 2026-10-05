/**
 * Pure pixel maths for turning an EUMETView picture into a map overlay.
 *
 * The service returns plain latitude/longitude pictures, but the map is Mercator, where each degree of latitude is
 * taller than the last one going north. So the picture's rows are re-spaced to Mercator before it is placed on the
 * map, and its dark or empty parts are made see-through.
 */
import { SATELLITE_BOUNDS, SatelliteProduct } from './satellite.config';

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

/**
 * Opacity 0..255 of one pixel. Colour pictures (HRV) keep everything except true black, which is the empty corner or
 * edge of the image. Infrared is grey: clear ground is dark, so it fades out and only cloud (bright) is drawn.
 */
export function pixelAlpha(mode: SatelliteProduct['mode'], r: number, g: number, b: number): number {
  if (mode === 'dark-fade') return Math.round(255 * smoothstep(3, 14, Math.max(r, g, b)));
  const luma = (r + g + b) / 3 / 255;
  return Math.round(255 * smoothstep(0.2, 0.55, luma) * 0.92);
}

/**
 * Re-space the rows of an RGBA picture to Mercator (linear blend between the two nearest source rows) and set its
 * opacity. `src` is `width` x `srcHeight`; the result is `width` x `outHeight`.
 */
export function toOverlayPixels(
  src: Uint8ClampedArray,
  width: number,
  srcHeight: number,
  mode: SatelliteProduct['mode'],
  outHeight = mercatorHeight(width),
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * outHeight * 4);
  const rowMap = mercatorRowMap(srcHeight, outHeight);
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
      const red = src[a + i] * (1 - w) + src[c + i] * w;
      const green = src[a + i + 1] * (1 - w) + src[c + i + 1] * w;
      const blue = src[a + i + 2] * (1 - w) + src[c + i + 2] * w;
      out[o] = red;
      out[o + 1] = green;
      out[o + 2] = blue;
      out[o + 3] = pixelAlpha(mode, red, green, blue);
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
