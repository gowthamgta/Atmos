/// <reference lib="webworker" />
import { buildLumaGrid, deblockJpeg, mercatorHeight, toOverlayPixels } from './satellite-image';
import { ColourPicture, enhancePicture } from './satellite-enhance';
import { SatelliteChannel, SatelliteView } from './satellite.config';

export interface SatelliteWorkerRequest {
  id: number;
  jpeg: Blob;
  kind: SatelliteChannel;
  view: SatelliteView;
  /** The natural-colour picture: finds low cloud in the cloud-only view, and gives the enhanced full picture its colours (daytime Meteosat). */
  natural?: Blob;
  /** Enhance the full picture (see satellite-enhance.ts); the other views are always built from the pictures as served. */
  enhance?: boolean;
  /** Infrared picture for the same frame during dawn/dusk twilight, blended across the solar terminator. */
  twilightIr?: Blob;
  /** Frame timestamp in epoch ms (needed for solar terminator position during twilight). */
  timeMs?: number;
}

export type SatelliteWorkerResponse =
  | { id: number; png: Blob; lumaGrid: Uint8Array }
  | { id: number; error: string };

/** A picture at its own size (not stretched to the main one's), free of its JPEG blocks. */
async function decodeRaster(blob: Blob): Promise<ColourPicture> {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = ctx.getImageData(0, 0, width, height).data;
  deblockJpeg(data, width, height);
  return { data, width, height };
}

/** Decodes a satellite picture and builds the overlay (Mercator rows, colour, opacity) off the main thread. */
addEventListener('message', async (event: MessageEvent<SatelliteWorkerRequest>) => {
  const { id, jpeg, kind, view, natural, twilightIr, timeMs, enhance } = event.data;
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
    if (enhance && view === 'picture') {
      // the full picture only: the hover readout (built above) and the thermal view read the pictures as the service made them
      const colourPicture = natural && kind === 'hrv' ? await decodeRaster(natural) : undefined;
      enhancePicture(src, width, height, kind, colourPicture);
      if (irPixels) enhancePicture(irPixels, width, height, 'ir');
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
