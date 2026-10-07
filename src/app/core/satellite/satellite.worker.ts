/// <reference lib="webworker" />
import { deblockJpeg, mercatorHeight, toOverlayPixels } from './satellite-image';
import { SatelliteChannel, SatelliteView } from './satellite.config';

export interface SatelliteWorkerRequest {
  id: number;
  jpeg: Blob;
  kind: SatelliteChannel;
  view: SatelliteView;
  /** The natural-colour picture, shown instead of the HRV one in the `natural` view (daytime Meteosat). */
  natural?: Blob;
}

export type SatelliteWorkerResponse = { id: number; png: Blob } | { id: number; error: string };

/** Decodes a satellite picture and builds the overlay (Mercator rows, colour, opacity) off the main thread. */
addEventListener('message', async (event: MessageEvent<SatelliteWorkerRequest>) => {
  const { id, jpeg, kind, view, natural } = event.data;
  try {
    const bitmap = await createImageBitmap(jpeg);
    const { width, height } = bitmap;
    const scratch = new OffscreenCanvas(width, height);
    const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    let src = sctx.getImageData(0, 0, width, height).data;
    deblockJpeg(src, width, height); // the service sends JPEG: remove its block seams before they can be sharpened
    if (natural && kind === 'hrv' && view === 'natural') {
      const colourBitmap = await createImageBitmap(natural);
      sctx.clearRect(0, 0, width, height);
      sctx.drawImage(colourBitmap, 0, 0, width, height);
      colourBitmap.close();
      src = sctx.getImageData(0, 0, width, height).data;
      deblockJpeg(src, width, height);
    }
    const outHeight = mercatorHeight(width);
    const pixels = toOverlayPixels(src, width, height, kind, view === 'natural' ? 'picture' : view, outHeight);
    const out = new OffscreenCanvas(width, outHeight);
    out.getContext('2d')!.putImageData(new ImageData(pixels, width, outHeight), 0, 0);
    const png = await out.convertToBlob({ type: 'image/png' });
    postMessage({ id, png } satisfies SatelliteWorkerResponse);
  } catch (e) {
    postMessage({ id, error: String(e) } satisfies SatelliteWorkerResponse);
  }
});
