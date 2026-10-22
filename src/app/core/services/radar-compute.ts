import { IMD_RADAR_STATIONS, type ProcessedRadarResult, type RadarProductKey } from '../domain/models/radar.model';
import { composeRadarMosaic } from './radar-mosaic';
import { lowestBeamHeights, withAloftFade } from './radar-beam';
import { nowcastPicture, type FieldBox } from './radar-nowcast';
import type { MotionField } from './radar-motion';

/**
 * The radar work that took the main thread for up to a second on a phone (measured with e2e/perf.mjs, CPU 4x slower): composing the mosaic of the
 * radars (with the rain-aloft fade, radar-beam.ts) and the nowcast pictures. It runs in a web worker (radar-compute.worker.ts); where there are
 * no workers (the tests, an old browser, a worker that failed) the same functions run here, so the results are the same either way.
 */

/** One radar's picture as the mosaic needs it (the rest of a result stays on the main thread). */
export type MosaicSource = [string, Pick<ProcessedRadarResult, 'fieldData' | 'timing' | 'isDisplayed'>];

export interface ComposeRequest {
  sources: MosaicSource[];
  kmPerPx: number;
  maxPx: number;
  product: RadarProductKey;
  nowMs?: number;
}

export interface NowcastRequest {
  field: Uint8Array;
  box: FieldBox;
  motion: MotionField;
  leads: readonly number[];
  outScale: number;
}

export interface NowcastPicture {
  lead: number;
  field: Uint8Array;
  width: number;
  height: number;
}

/** Lowest beam height over each pixel of the mosaic, kept while the radars, the product and the grid stay the same. */
let beamCache: { key: string; heights: Float32Array } | null = null;

/** The mosaic of the radars, with faint echoes seen only from a beam high up made see-through (never removed). */
export function composeWithAloft(req: ComposeRequest): ProcessedRadarResult | null {
  const res = composeRadarMosaic(IMD_RADAR_STATIONS, req.sources as [string, ProcessedRadarResult][], req.kmPerPx, req.maxPx, req.product, req.nowMs);
  if (!res?.fieldData || !res.displayField) return res;
  const ids = req.sources.map(([id]) => id).sort();
  const { cropW: w, cropH: h } = res.fieldData;
  const key = [ids.join(','), req.product, w, h, ...res.coordinates.flat()].join('|');
  if (beamCache?.key !== key) {
    beamCache = { key, heights: lowestBeamHeights(IMD_RADAR_STATIONS.filter(s => ids.includes(s.id)), req.product, res.coordinates, w, h) };
  }
  const fade = withAloftFade(res.fieldData.field, beamCache.heights, res.displayFade);
  return fade === res.displayFade ? res : { ...res, displayFade: fade };
}

export function nowcastPictures(req: NowcastRequest): NowcastPicture[] {
  return req.leads.map(lead => ({ lead, ...nowcastPicture(req.field, req.box, req.motion, lead, req.outScale) }));
}

type Job = { id: number } & ({ kind: 'compose'; req: ComposeRequest } | { kind: 'nowcast'; req: NowcastRequest });
export type ComputeJob = Job;
export type ComputeReply = { id: number; mosaic?: ProcessedRadarResult | null; pictures?: NowcastPicture[]; error?: string };

/** The buffers of a reply that can move to the other thread without a copy. */
export function replyTransfer(reply: ComputeReply): Transferable[] {
  const out: Transferable[] = [];
  const m = reply.mosaic;
  if (m) {
    out.push(m.fieldData.field.buffer);
    if (m.displayField) out.push(m.displayField.buffer);
    if (m.displayFade && m.displayFade.buffer !== m.displayField?.buffer) out.push(m.displayFade.buffer);
  }
  for (const p of reply.pictures ?? []) out.push(p.field.buffer);
  return [...new Set(out)];
}

/** Runs a job (in the worker, or here as the fallback). */
export function runJob(job: Job): ComputeReply {
  try {
    if (job.kind === 'compose') return { id: job.id, mosaic: composeWithAloft(job.req) };
    return { id: job.id, pictures: nowcastPictures(job.req) };
  } catch (e) {
    return { id: job.id, error: String(e) };
  }
}

/** The client: one worker for the radar's heavy work, the main thread when there is none. */
export class RadarCompute {
  private worker: Worker | null = null;
  private broken = false;
  private nextId = 1;
  private readonly pending = new Map<number, (r: ComputeReply) => void>();

  private get usable(): boolean {
    return !this.broken && typeof Worker !== 'undefined';
  }

  private start(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./radar-compute.worker', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<ComputeReply>) => {
        const done = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        done?.(e.data);
      };
      this.worker.onerror = () => this.fail();
    }
    return this.worker;
  }

  /** The worker died: what was pending is run here, and so is everything after. */
  private fail(): void {
    this.broken = true;
    this.worker?.terminate();
    this.worker = null;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const done of waiting) done({ id: 0, error: 'worker failed' });
  }

  private run(job: Omit<Job, 'id'>): Promise<ComputeReply> {
    const id = this.nextId++;
    const full = { ...job, id } as Job;
    if (!this.usable) return Promise.resolve(runJob(full));
    return new Promise(resolve => {
      this.pending.set(id, r => resolve(r.error === 'worker failed' ? runJob(full) : r));
      this.start().postMessage(full); // the radars' fields are copied over: they stay here for the readout and the loop
    });
  }

  async compose(req: ComposeRequest): Promise<ProcessedRadarResult | null> {
    const r = await this.run({ kind: 'compose', req });
    return r.mosaic ?? null;
  }

  async nowcast(req: NowcastRequest): Promise<NowcastPicture[]> {
    const r = await this.run({ kind: 'nowcast', req });
    return r.pictures ?? [];
  }
}
