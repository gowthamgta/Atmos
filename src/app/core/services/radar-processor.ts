import { GifReader } from 'omggif';
import { RadarPixelOptions, layoutMatches, processRadarPixels } from './radar-process';
import type { RadarWorkerRequest, RadarWorkerResult } from './radar-process.worker';
import { StampBox, readStampTime } from './radar-stamp';

export type StillResult = Omit<RadarWorkerResult, 'id' | 'frames'>;

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

/** One animation GIF opened for decoding frame by frame (the one-hour loop). */
export interface HistoryHandle {
  handle: number;
  width: number;
  height: number;
  frames: number;
}

/**
 * Decodes radar GIFs and builds their intensity fields in web workers, so the map stays smooth while a refresh is processed.
 * Without Worker support (tests, old browsers) or if a worker dies, the same functions run on the main thread: the results
 * are identical.
 */
export class RadarProcessor {
  private workers: Worker[] = [];
  private broken = false;
  private nextId = 1;
  private nextHandle = 1;
  private turn = 0;
  private readonly pending = new Map<number, (r: RadarWorkerResult) => void>();
  private readonly owner = new Map<number, number>();            // history handle -> worker index
  private readonly inline = new Map<number, GifReader>();       // history handle -> reader, when run on the main thread

  /** How many workers: two where the machine has the cores for it (two stations decode at once), else one. */
  private static poolSize(): number {
    const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
    return cores >= 4 ? 2 : 1;
  }

  private get usable(): boolean {
    return !this.broken && typeof Worker !== 'undefined';
  }

  private worker(index: number): Worker {
    if (this.workers.length === 0) {
      for (let i = 0; i < RadarProcessor.poolSize(); i++) {
        const w = new Worker(new URL('./radar-process.worker', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<RadarWorkerResult>) => {
          const done = this.pending.get(e.data.id);
          this.pending.delete(e.data.id);
          done?.(e.data);
        };
        w.onerror = () => this.fail();
        this.workers.push(w);
      }
    }
    return this.workers[index % this.workers.length];
  }

  /** A worker could not start or crashed: everything pending is answered as not decoded, and the main thread takes over. */
  private fail(): void {
    this.broken = true;
    for (const [id, done] of this.pending) done({ id, decoded: false, w: 0, h: 0, layoutOk: false, field: null, stamp: null, frames: 0, error: 'worker failed' });
    this.pending.clear();
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }

  private call(index: number, req: WithoutId<RadarWorkerRequest>, transfer: Transferable[] = []): Promise<RadarWorkerResult> {
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      try {
        this.worker(index).postMessage({ ...req, id }, transfer);
      } catch {
        this.fail();
      }
    });
  }

  /**
   * The picture's intensity field (and, when `stampBox` is given, the scan time printed on it). `bytes` is handed over to the
   * worker: it is no longer usable afterwards, except that it comes back in the result when the GIF could not be decoded.
   */
  async still(bytes: ArrayBuffer, options: RadarPixelOptions, stampBox?: StampBox): Promise<StillResult> {
    if (this.usable) {
      const r = await this.call(this.turn++, { op: 'still', bytes, options, stampBox }, [bytes]);
      if (r.decoded || !this.broken) return r;
      // the worker failed: its answer carries no bytes, so there is nothing to retry with
      return r;
    }
    return RadarProcessor.stillInline(bytes, options, stampBox);
  }

  static stillInline(bytes: ArrayBuffer, options: RadarPixelOptions, stampBox?: StampBox): StillResult {
    let reader: GifReader;
    try {
      reader = new GifReader(new Uint8Array(bytes));
    } catch {
      return { decoded: false, w: 0, h: 0, layoutOk: false, field: null, stamp: null, bytes };
    }
    const w = reader.width;
    const h = reader.height;
    const rgba = new Uint8Array(w * h * 4);
    reader.decodeAndBlitFrameRGBA(Math.max(0, reader.numFrames() - 1), rgba);
    const stamp = stampBox ? readStampTime(rgba, w, h, stampBox) : null;
    if (w < 50 || h < 50) return { decoded: true, w, h, layoutOk: false, field: null, stamp };
    const layoutOk = layoutMatches(options.crop, w, h);
    return { decoded: true, w, h, layoutOk, field: layoutOk ? processRadarPixels(rgba, w, h, options) : null, stamp };
  }

  /** Opens an animation GIF (`bytes` is copied; the caller keeps its own). Null when it cannot be decoded. */
  async open(bytes: Uint8Array): Promise<HistoryHandle | null> {
    const handle = this.nextHandle++;
    if (this.usable) {
      const index = this.turn++;
      const copy = bytes.slice().buffer;
      const r = await this.call(index, { op: 'open', handle, bytes: copy }, [copy]);
      if (r.decoded) {
        this.owner.set(handle, index);
        return { handle, width: r.w, height: r.h, frames: r.frames };
      }
      if (!this.broken) return null;
    }
    try {
      const reader = new GifReader(bytes);
      this.inline.set(handle, reader);
      return { handle, width: reader.width, height: reader.height, frames: reader.numFrames() };
    } catch {
      return null;
    }
  }

  /** The intensity field of one frame of an opened GIF. */
  async frame(h: HistoryHandle, index: number, options: RadarPixelOptions): Promise<{ layoutOk: boolean; field: Float32Array | null } | null> {
    const owner = this.owner.get(h.handle);
    if (owner !== undefined && this.usable) {
      const r = await this.call(owner, { op: 'frame', handle: h.handle, index, options });
      return r.decoded ? { layoutOk: r.layoutOk, field: r.field } : null;
    }
    const reader = this.inline.get(h.handle);
    if (!reader) return null;
    const rgba = new Uint8Array(h.width * h.height * 4);
    reader.decodeAndBlitFrameRGBA(index, rgba);
    const layoutOk = layoutMatches(options.crop, h.width, h.height);
    return { layoutOk, field: layoutOk ? processRadarPixels(rgba, h.width, h.height, options) : null };
  }

  close(h: HistoryHandle): void {
    this.inline.delete(h.handle);
    const owner = this.owner.get(h.handle);
    this.owner.delete(h.handle);
    if (owner !== undefined && this.workers.length > 0) this.workers[owner % this.workers.length].postMessage({ op: 'close', handle: h.handle });
  }
}
