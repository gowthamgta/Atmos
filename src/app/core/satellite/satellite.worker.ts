/// <reference lib="webworker" />
import { mercatorHeight, toOverlayPixels, toRawMercator } from './satellite-image';
import { enhancePicture, pictureScale } from './satellite-enhance';
import { encodePng } from './png-encode';
import { SATELLITE_BOUNDS } from './satellite.config';
import { FlowField, MotionGrid, cloudFlow, motionGrid } from './satellite-flow';

/** One of our RGB pictures (the HRV Cloud picture of the satellite workflow, on the app's satellite box) to re-space to Mercator. */
export interface SatelliteWorkerRequest {
  id: number;
  picture: Blob;
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
  | { id: number; png: Blob; motion?: MotionGrid }
  | { id: number; field: FlowField | null }
  | { id: number; pack: { w: number; h: number; rgb: Uint8Array } | null }
  | { id: number; error: string };

/** Decodes a satellite picture and re-spaces it to Mercator off the main thread (and works out the loop's cloud motion, and decodes data packs). */
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
  const { id, picture } = event.data;
  const box = SATELLITE_BOUNDS;
  try {
    const bitmap = await createImageBitmap(picture);
    const { width, height } = bitmap;
    const scratch = new OffscreenCanvas(width, height);
    const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const src = sctx.getImageData(0, 0, width, height).data;
    const outHeight = mercatorHeight(width, box);
    // the picture in its own colours (the satellite's RGB on cloud, land and sea), re-spaced to Mercator
    const png = encodePng(toRawMercator(src, width, height, outHeight, box), width, outHeight); // not via a canvas: its premultiplied storage bands faint cloud
    // how much cloud is where (the HRV picture cleared of the ground), for the loop's motion between pictures
    enhancePicture(src, width, height, 'hrv', pictureScale(box, width));
    const motion = motionGrid(toOverlayPixels(src, width, height, 'hrv', outHeight, undefined, undefined, box), width, outHeight);
    postMessage({ id, png, motion } satisfies SatelliteWorkerResponse, [motion.data.buffer]);
  } catch (e) {
    postMessage({ id, error: String(e) } satisfies SatelliteWorkerResponse);
  }
});

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
