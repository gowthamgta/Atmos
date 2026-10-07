/// <reference lib="webworker" />
import { GifReader } from 'omggif';
import { RadarPixelOptions, layoutMatches, processRadarPixels } from './radar-process';
import { StampBox, StampTime, readStampTime } from './radar-stamp';

/**
 * Radar pictures decoded and turned into intensity fields off the main thread: a GIF decode takes 200 ms for the biggest
 * stations and the colour classification another 90, which would freeze the map for a moment on every refresh.
 */
export type RadarWorkerRequest =
  | { op: 'still'; id: number; bytes: ArrayBuffer; options: RadarPixelOptions; stampBox?: StampBox }
  | { op: 'open'; id: number; handle: number; bytes: ArrayBuffer }
  | { op: 'frame'; id: number; handle: number; index: number; options: RadarPixelOptions }
  | { op: 'close'; handle: number };

export interface RadarWorkerResult {
  id: number;
  /** False when the GIF could not be decoded (`bytes` then comes back, so the caller can try another way). */
  decoded: boolean;
  w: number;
  h: number;
  layoutOk: boolean;
  field: Float32Array | null;
  stamp: StampTime | null;
  /** Number of frames (for `open`). */
  frames: number;
  bytes?: ArrayBuffer;
  error?: string;
}

const readers = new Map<number, GifReader>();

function reply(result: RadarWorkerResult): void {
  const transfer: Transferable[] = [];
  if (result.field) transfer.push(result.field.buffer);
  if (result.bytes) transfer.push(result.bytes);
  postMessage(result, { transfer });
}

const empty = (id: number): RadarWorkerResult => ({ id, decoded: false, w: 0, h: 0, layoutOk: false, field: null, stamp: null, frames: 0 });

function fieldOf(rgba: Uint8Array, w: number, h: number, options: RadarPixelOptions): { layoutOk: boolean; field: Float32Array | null } {
  const layoutOk = layoutMatches(options.crop, w, h);
  return { layoutOk, field: layoutOk ? processRadarPixels(rgba, w, h, options) : null };
}

addEventListener('message', (event: MessageEvent<RadarWorkerRequest>) => {
  const req = event.data;
  try {
    if (req.op === 'close') {
      readers.delete(req.handle);
      return;
    }
    if (req.op === 'still') {
      let reader: GifReader;
      try {
        reader = new GifReader(new Uint8Array(req.bytes));
      } catch {
        reply({ ...empty(req.id), bytes: req.bytes });
        return;
      }
      const w = reader.width;
      const h = reader.height;
      const rgba = new Uint8Array(w * h * 4);
      reader.decodeAndBlitFrameRGBA(Math.max(0, reader.numFrames() - 1), rgba);
      const stamp = req.stampBox ? readStampTime(rgba, w, h, req.stampBox) : null;
      const { layoutOk, field } = w < 50 || h < 50 ? { layoutOk: false, field: null } : fieldOf(rgba, w, h, req.options);
      reply({ id: req.id, decoded: true, w, h, layoutOk, field, stamp, frames: reader.numFrames() });
      return;
    }
    if (req.op === 'open') {
      try {
        const reader = new GifReader(new Uint8Array(req.bytes));
        readers.set(req.handle, reader);
        reply({ ...empty(req.id), decoded: true, w: reader.width, h: reader.height, frames: reader.numFrames() });
      } catch {
        reply(empty(req.id));
      }
      return;
    }
    // frame
    const reader = readers.get(req.handle);
    if (!reader) {
      reply(empty(req.id));
      return;
    }
    const w = reader.width;
    const h = reader.height;
    const rgba = new Uint8Array(w * h * 4);
    reader.decodeAndBlitFrameRGBA(req.index, rgba);
    const { layoutOk, field } = fieldOf(rgba, w, h, req.options);
    reply({ id: req.id, decoded: true, w, h, layoutOk, field, stamp: null, frames: 0 });
  } catch (e) {
    if ('id' in req) reply({ ...empty(req.id), error: String(e) });
  }
});
