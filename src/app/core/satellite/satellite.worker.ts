/// <reference lib="webworker" />
import { buildLumaGrid, deblockJpeg, hrvBackground, mercatorHeight, toOverlayPixels } from './satellite-image';
import { BrightnessGrid, CloudField, buildCloudField } from './cloud-field';
import { enhancePicture } from './satellite-enhance';
import { encodePng } from './png-encode';
import { pictureScale } from './satellite-window';
import { GeoBounds, SATELLITE_BOUNDS, SatelliteChannel } from './satellite.config';
import { FlowField, MotionGrid, cloudFlow, motionGrid } from './satellite-flow';

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
  /** The frame's measured brightness temperatures (pipeline/satellite_bt.py), for the 3D clouds' heights. */
  bt?: { url: string; offsetK: number; stepK: number };
}

/** One of our own data packs (own-products.ts) to decode for the hover readout: its RGB bytes. */
export interface SatelliteDecodeRequest {
  id: number;
  decode: string;
}

/** The cloud motion between two pictures' motion grids (see satellite-flow.ts). */
export interface SatelliteFlowRequest {
  id: number;
  flow: { a: MotionGrid; b: MotionGrid };
}

export type SatelliteWorkerResponse =
  | { id: number; png: Blob; lumaGrid?: Uint8Array; motion?: MotionGrid; cloudField?: CloudField }
  | { id: number; field: FlowField | null }
  | { id: number; pack: { w: number; h: number; rgb: Uint8Array } | null }
  | { id: number; error: string };

/** Decodes a satellite picture and builds the overlay (Mercator rows, colour, opacity) off the main thread. */
addEventListener('message', async (event: MessageEvent<SatelliteWorkerRequest | SatelliteFlowRequest | SatelliteDecodeRequest>) => {
  if ('decode' in event.data) {
    const { id, decode } = event.data;
    const pack = await decodePack(decode);
    postMessage({ id, pack } satisfies SatelliteWorkerResponse, pack ? [pack.rgb.buffer] : []);
    return;
  }
  if ('flow' in event.data) {
    const { id, flow } = event.data;
    try {
      const field = cloudFlow(flow.a, flow.b);
      postMessage({ id, field } satisfies SatelliteWorkerResponse, field ? [field.data.buffer] : []);
    } catch (e) {
      postMessage({ id, error: String(e) } satisfies SatelliteWorkerResponse);
    }
    return;
  }
  const { id, jpeg, kind, twilightIr, timeMs, bounds, lossless, bt } = event.data;
  const box = bounds ?? SATELLITE_BOUNDS;
  try {
    const bitmap = await createImageBitmap(jpeg);
    const { width, height } = bitmap;
    const scratch = new OffscreenCanvas(width, height);
    const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const src = sctx.getImageData(0, 0, width, height).data;
    if (!lossless) deblockJpeg(src, width, height); // the service sends JPEG: remove its block seams before they can be sharpened
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
    // the whole-India picture also gives the clouds' heights and thickness for the 3D view (cloud-field.ts)
    const cover = !bounds && kind === 'hrv' ? new Uint8Array(width * outHeight) : undefined;
    const pixels = toOverlayPixels(src, width, height, kind, outHeight, irPixels, timeMs, box, cover);
    const grid = !bounds && bt ? await brightnessGrid(bt) : null;
    const field = bounds ? undefined : buildCloudField(src, width, height, kind, outHeight, cover ?? null, kind === 'hrv' ? hrvBackground(src) : 0, grid);
    const png = encodePng(pixels, width, outHeight); // not via a canvas: its premultiplied storage bands the colour of faint cloud
    // how much cloud is where, for the loop's motion between pictures (the whole-India picture only: a window follows its motion)
    const motion = bounds ? undefined : motionGrid(pixels, width, outHeight);
    const transfer: Transferable[] = [];
    if (lumaGrid) transfer.push(lumaGrid.buffer);
    if (motion) transfer.push(motion.data.buffer);
    if (field) transfer.push(field.data.buffer);
    postMessage({ id, png, lumaGrid, motion, cloudField: field } satisfies SatelliteWorkerResponse, transfer);
  } catch (e) {
    postMessage({ id, error: String(e) } satisfies SatelliteWorkerResponse);
  }
});

/** The measured brightness temperatures of a frame, or null when they cannot be had (the picture's grey level is used instead). */
async function brightnessGrid(bt: { url: string; offsetK: number; stepK: number }): Promise<BrightnessGrid | null> {
  try {
    const res = await fetch(bt.url);
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const grid = { w: bitmap.width, h: bitmap.height, data, offsetK: bt.offsetK, stepK: bt.stepK };
    bitmap.close();
    return grid;
  } catch {
    return null;
  }
}

/** A data pack's bytes (red, green, blue per pixel), or null when it cannot be had. */
async function decodePack(url: string): Promise<{ w: number; h: number; rgb: Uint8Array } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const rgb = new Uint8Array(bitmap.width * bitmap.height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
    const pack = { w: bitmap.width, h: bitmap.height, rgb };
    bitmap.close();
    return pack;
  } catch {
    return null;
  }
}
