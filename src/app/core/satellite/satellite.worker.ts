/// <reference lib="webworker" />
import { buildLumaGrid, deblockJpeg, mercatorHeight, toOverlayPixels } from './satellite-image';
import { HRV_DENOISE_SIGMA, HRV_WINDOW_DENOISE_SIGMA, denoiseHrv, enhancePicture } from './satellite-enhance';
import { encodePng } from './png-encode';
import { pictureScale } from './satellite-window';
import { GeoBounds, SATELLITE_BOUNDS, SatelliteChannel } from './satellite.config';

export interface SatelliteWorkerRequest {
  id: number;
  jpeg: Blob;
  kind: SatelliteChannel;
  /** Infrared picture for the same frame during dawn/dusk twilight, blended across the solar terminator. */
  twilightIr?: Blob;
  /** Frame timestamp in epoch ms (needed for solar terminator position during twilight). */
  timeMs?: number;
  /** The ground the picture covers, when it is a closer window and not all of India. */
  bounds?: GeoBounds;
  /** The picture is a PNG (no JPEG blocks to smooth). */
  lossless?: boolean;
}

export type SatelliteWorkerResponse =
  | { id: number; png: Blob; lumaGrid?: Uint8Array }
  | { id: number; error: string };

/** Decodes a satellite picture and builds the overlay (Mercator rows, colour, opacity) off the main thread. */
addEventListener('message', async (event: MessageEvent<SatelliteWorkerRequest>) => {
  const { id, jpeg, kind, twilightIr, timeMs, bounds, lossless } = event.data;
  const box = bounds ?? SATELLITE_BOUNDS;
  try {
    const bitmap = await createImageBitmap(jpeg);
    const { width, height } = bitmap;
    const scratch = new OffscreenCanvas(width, height);
    const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const src = sctx.getImageData(0, 0, width, height).data;
    if (!lossless) deblockJpeg(src, width, height); // the service sends JPEG: remove its block seams
    const lumaGrid = bounds ? undefined : buildLumaGrid(src, width, height, kind); // the hover readout reads the whole-India picture
    let irPixels: Uint8ClampedArray | undefined;
    if (twilightIr && kind === 'hrv' && timeMs !== undefined) {
      const irBitmap = await createImageBitmap(twilightIr);
      sctx.clearRect(0, 0, width, height);
      sctx.drawImage(irBitmap, 0, 0, width, height);
      irBitmap.close();
      irPixels = sctx.getImageData(0, 0, width, height).data;
      deblockJpeg(irPixels, width, height);
    }
    // the infrared steps go (the hover readout above reads the picture as the service made it)
    const scale = pictureScale(box, width);
    enhancePicture(src, width, height, kind, scale);
    if (irPixels) enhancePicture(irPixels, width, height, 'ir', scale);
    const outHeight = mercatorHeight(width, box);
    // the HRV's noise goes: lightly on the whole-India picture (the cumulus keep their texture), more on a closer window (its repeated pixels)
    const denoise = bounds ? HRV_WINDOW_DENOISE_SIGMA : HRV_DENOISE_SIGMA;
    if (kind === 'hrv') denoiseHrv(src, width, height, denoise * Math.min(1.3, Math.max(0.7, scale)));
    const pixels = toOverlayPixels(src, width, height, kind, outHeight, irPixels, timeMs, box);
    const png = encodePng(pixels, width, outHeight); // not via a canvas: its premultiplied storage bands the colour of faint cloud
    postMessage({ id, png, lumaGrid } satisfies SatelliteWorkerResponse, lumaGrid ? [lumaGrid.buffer] : []);
  } catch (e) {
    postMessage({ id, error: String(e) } satisfies SatelliteWorkerResponse);
  }
});
