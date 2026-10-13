/// <reference lib="webworker" />
import { buildLumaGrid, deblockJpeg, mercatorHeight, toOverlayPixels } from './satellite-image';
import { SatelliteChannel, SatelliteView } from './satellite.config';

export interface SatelliteWorkerRequest {
  id: number;
  jpeg: Blob;
  kind: SatelliteChannel;
  view: SatelliteView;
  /** The natural-colour picture, used to find low cloud in the cloud-only view (daytime Meteosat). */
  natural?: Blob;
  /** Infrared picture for the same frame during dawn/dusk twilight, blended across the solar terminator. */
  twilightIr?: Blob;
  /** Frame timestamp in epoch ms (needed for solar terminator position during twilight). */
  timeMs?: number;
}

export type SatelliteWorkerResponse =
  | { id: number; png: Blob; lumaGrid: Uint8Array }
  | { id: number; error: string };

/** Decodes a satellite picture and builds the overlay (Mercator rows, colour, opacity) off the main thread. */
addEventListener('message', async (event: MessageEvent<SatelliteWorkerRequest>) => {
  const { id, jpeg, kind, view, natural, twilightIr, timeMs } = event.data;
  try {
    const bitmap = await createImageBitmap(jpeg);
    const { width, height } = bitmap;
    const scratch = new OffscreenCanvas(width, height);
    const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const src = sctx.getImageData(0, 0, width, height).data;
    deblockJpeg(src, width, height); // the service sends JPEG: remove its block seams before they can be sharpened
    const lumaGrid = buildLumaGrid(src, width, height, kind);
    let colour: Uint8ClampedArray | undefined;
    if (natural && kind === 'hrv' && view === 'clouds') {
      const colourBitmap = await createImageBitmap(natural);
      sctx.clearRect(0, 0, width, height);
      sctx.drawImage(colourBitmap, 0, 0, width, height);
      colourBitmap.close();
      colour = sctx.getImageData(0, 0, width, height).data;
    }
    let irPixels: Uint8ClampedArray | undefined;
    if (twilightIr && kind === 'hrv' && timeMs !== undefined) {
      const irBitmap = await createImageBitmap(twilightIr);
      sctx.clearRect(0, 0, width, height);
      sctx.drawImage(irBitmap, 0, 0, width, height);
      irBitmap.close();
      irPixels = sctx.getImageData(0, 0, width, height).data;
      deblockJpeg(irPixels, width, height);
    }
    const outHeight = mercatorHeight(width);
    const pixels = toOverlayPixels(src, width, height, kind, view, outHeight, colour, irPixels, timeMs);
    const out = new OffscreenCanvas(width, outHeight);
    out.getContext('2d')!.putImageData(new ImageData(pixels, width, outHeight), 0, 0);
    const png = await out.convertToBlob({ type: 'image/png' });
    postMessage({ id, png, lumaGrid } satisfies SatelliteWorkerResponse, [lumaGrid.buffer]);
  } catch (e) {
    postMessage({ id, error: String(e) } satisfies SatelliteWorkerResponse);
  }
});
