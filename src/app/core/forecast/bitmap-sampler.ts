import { ForecastGrid, decodeRg16, gridPosition } from './forecast.model';

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

let ctx: Canvas2D | null = null;

function scratchContext(): Canvas2D {
  if (!ctx) {
    const canvas: OffscreenCanvas | HTMLCanvasElement =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(2, 2) : Object.assign(document.createElement('canvas'), { width: 2, height: 2 });
    ctx = canvas.getContext('2d', { willReadFrequently: true }) as Canvas2D;
  }
  return ctx;
}

/** Reads the exact RGBA bytes of a 2x2 block of an image (a 1:1 copy, so packed values survive). */
function readBlock(bitmap: ImageBitmap, x: number, y: number): Uint8ClampedArray {
  const c = scratchContext();
  c.clearRect(0, 0, 2, 2);
  c.drawImage(bitmap, x, y, 2, 2, 0, 0, 2, 2);
  return c.getImageData(0, 0, 2, 2).data;
}

/**
 * Bilinear value of an rg16 field image at lat/lon, reading only the four surrounding texels.
 * Returns NaN outside the grid or where all four texels are flagged "no data".
 */
export function sampleRg16Bitmap(
  bitmap: ImageBitmap,
  grid: Pick<ForecastGrid, 'latMax' | 'lonMin' | 'step' | 'nx' | 'ny'>,
  lat: number,
  lon: number,
  min: number,
  max: number
): number {
  const { x, y } = gridPosition(grid as ForecastGrid, lat, lon);
  if (x < 0 || y < 0 || x > grid.nx - 1 || y > grid.ny - 1) return NaN;
  const x0 = Math.min(Math.floor(x), grid.nx - 2);
  const y0 = Math.min(Math.floor(y), grid.ny - 2);
  const fx = x - x0;
  const fy = y - y0;
  const px = readBlock(bitmap, x0, y0);
  let sum = 0;
  let wsum = 0;
  for (let k = 0; k < 4; k++) {
    const ox = k & 1;
    const oy = k >> 1;
    const o = (oy * 2 + ox) * 4;
    const v = decodeRg16(px[o], px[o + 1], px[o + 2], min, max);
    if (Number.isNaN(v)) continue;
    const w = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
    sum += v * w;
    wsum += w;
  }
  return wsum > 1e-3 ? sum / wsum : NaN;
}
