/// <reference lib="webworker" />
import { MercatorBox, RealRadarInput, StrikeInput, SyntheticRadarConfig, SyntheticRadarStats, WindGrids, synthesizeRadar } from './synthetic-radar';
import { PairRadar, RainModel, RainPairs, collectPairs } from './rain-features';

export interface SyntheticRadarRequest {
  id: number;
  /** The newest data pack, and those of the last hour before it (each with how many minutes older it is). */
  url: string;
  history: { url: string; minutesAgo: number }[];
  /** The newest frame's RGB picture (its red is the visible, for thick cloud by day) and its time. */
  rgbUrl?: string;
  timeMs: number;
  box: MercatorBox;
  minK: number;
  spanK: number;
  wind: WindGrids | null;
  strikes: StrikeInput[];
  radar: RealRadarInput | null;
  config: SyntheticRadarConfig;
  /** The learned model (public/data/rain-model.json), read again every hour; null: the hand-set rules only. */
  modelUrl: string | null;
  /** The nowcast bot only: the radar picture nearest the frame's time, to pair with the satellite's inputs (rain-features.ts). */
  pairRadar?: PairRadar | null;
}

export type SyntheticRadarResponse =
  | { id: number; w: number; h: number; dbz4: Uint8Array; stats: SyntheticRadarStats; pairs?: RainPairs | null }
  | { id: number; error: string };

interface Pack {
  w: number;
  h: number;
  /** 10.8, 6.2 and 7.3 um temperatures (K, 0 = no data). */
  ir: Float32Array;
  wv: Float32Array;
  wv73: Float32Array;
}

/** Decoded packs by address: the newest hour's are kept for the next run. */
const packs = new Map<string, Pack>();
/** The newest frame's visible on the data's grid, by its picture's address. */
let visible: { url: string; w: number; h: number; vis: Uint8Array } | null = null;

async function packOf(url: string, minK: number, spanK: number): Promise<Pack | null> {
  const hit = packs.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) return null;
  const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const ir = new Float32Array(bitmap.width * bitmap.height);
  const wv = new Float32Array(bitmap.width * bitmap.height);
  const wv73 = new Float32Array(bitmap.width * bitmap.height);
  for (let i = 0; i < ir.length; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    ir[i] = r === 0 ? 0 : minK + (r / 255) * spanK;
    wv[i] = g === 0 ? 0 : minK + (g / 255) * spanK;
    wv73[i] = b === 0 ? 0 : minK + (b / 255) * spanK;
  }
  const pack = { w: bitmap.width, h: bitmap.height, ir, wv, wv73 };
  bitmap.close();
  packs.set(url, pack);
  while (packs.size > 6) packs.delete(packs.keys().next().value!);
  return pack;
}

/** The learned model as last read, and when. */
let model: { url: string; at: number; model: RainModel | null } | null = null;
const MODEL_MS = 60 * 60_000;

async function modelOf(url: string | null): Promise<RainModel | null> {
  if (!url) return null;
  if (model?.url === url && Date.now() - model.at < MODEL_MS) return model.model;
  let m: RainModel | null = model?.url === url ? model.model : null;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    m = res.ok ? ((await res.json()) as RainModel) : null;
  } catch {
    // kept as it was; tried again within the hour
  }
  model = { url, at: Date.now(), model: m };
  return m;
}

/** The RGB picture's red resampled to the data's grid (the same box), or null when it cannot be had. */
async function visibleOf(url: string, w: number, h: number): Promise<Uint8Array | null> {
  if (visible?.url === url && visible.w === w && visible.h === h) return visible.vis;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob(), { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const vis = new Uint8Array(w * h);
    for (let i = 0; i < vis.length; i++) vis[i] = rgba[i * 4];
    visible = { url, w, h, vis };
    return vis;
  } catch {
    return null;
  }
}

/** Builds the synthetic radar (synthetic-radar.ts) off the main thread. */
addEventListener('message', async (event: MessageEvent<SyntheticRadarRequest>) => {
  const r = event.data;
  try {
    const now = await packOf(r.url, r.minK, r.spanK);
    if (!now) throw new Error('no data pack');
    const history: { ir: Float32Array; wv: Float32Array; minutesAgo: number }[] = [];
    for (const fr of r.history) {
      const p = await packOf(fr.url, r.minK, r.spanK).catch(() => null);
      if (p && p.w === now.w && p.h === now.h) history.push({ ir: p.ir, wv: p.wv, minutesAgo: fr.minutesAgo });
    }
    packs.delete(r.url); // the newest stays last (kept longest)
    packs.set(r.url, now);
    const vis = r.rgbUrl ? await visibleOf(r.rgbUrl, now.w, now.h) : null;
    const input = { w: now.w, h: now.h, box: r.box, ir: now.ir, wv: now.wv, wv73: now.wv73, vis, timeMs: r.timeMs, history, wind: r.wind, strikes: r.strikes };
    const out = synthesizeRadar({ ...input, radar: r.radar, model: await modelOf(r.modelUrl) }, r.config);
    // the bot's pairs: the satellite's inputs against the radar at the same time, beside what the hand-set rules drew there (unshifted)
    let pairs: RainPairs | null = null;
    if (r.pairRadar) {
      const hand = out.stats.learned ? synthesizeRadar({ ...input, radar: null, model: null }, r.config) : out;
      pairs = collectPairs(input, r.pairRadar, r.timeMs, { dbz4: hand.dbz4, w: hand.w, h: hand.h, offsetDb: hand === out ? out.stats.offsetDb : 0 });
    }
    postMessage({ id: r.id, w: out.w, h: out.h, dbz4: out.dbz4, stats: out.stats, pairs } satisfies SyntheticRadarResponse, [out.dbz4.buffer]);
  } catch (e) {
    postMessage({ id: r.id, error: String(e) } satisfies SyntheticRadarResponse);
  }
});
