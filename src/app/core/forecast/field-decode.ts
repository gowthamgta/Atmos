import { decodeRg16 } from './forecast.model';

const cache = new WeakMap<ImageBitmap, Float32Array>();
let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;

/**
 * Decodes a whole rg16 field image into one Float32Array (row-major, NaN where flagged "no data").
 * The result is cached per bitmap, so replaying the timeline does not decode the same image twice.
 */
export function decodeFieldBitmap(bitmap: ImageBitmap, min: number, max: number): Float32Array {
  const hit = cache.get(bitmap);
  if (hit) return hit;

  const { width, height } = bitmap;
  canvas ??= typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0); // 1:1, so the packed bytes survive
  const px = ctx.getImageData(0, 0, width, height).data;

  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    out[i] = decodeRg16(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], min, max);
  }
  cache.set(bitmap, out);
  return out;
}
