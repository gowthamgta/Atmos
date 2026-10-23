/// <reference lib="webworker" />
import { MercatorBox, RealRadarInput, StrikeInput, SyntheticRadarConfig, SyntheticRadarStats, WindGrids, synthesizeRadar } from './synthetic-radar';

export interface SyntheticRadarRequest {
  id: number;
  /** The newest data pack, and those of the last hour before it (each with how many minutes older it is). */
  url: string;
  history: { url: string; minutesAgo: number }[];
  box: MercatorBox;
  minK: number;
  spanK: number;
  wind: WindGrids | null;
  strikes: StrikeInput[];
  radar: RealRadarInput | null;
  config: SyntheticRadarConfig;
}

export type SyntheticRadarResponse =
  | { id: number; w: number; h: number; dbz4: Uint8Array; stats: SyntheticRadarStats }
  | { id: number; error: string };

/** Decoded packs (10.8 um temperatures, K, 0 = no data) by address: the newest hour's are kept for the next run. */
const packs = new Map<string, { w: number; h: number; ir: Float32Array }>();

async function irOf(url: string, minK: number, spanK: number): Promise<{ w: number; h: number; ir: Float32Array } | null> {
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
  for (let i = 0; i < ir.length; i++) {
    const v = rgba[i * 4];
    ir[i] = v === 0 ? 0 : minK + (v / 255) * spanK;
  }
  const pack = { w: bitmap.width, h: bitmap.height, ir };
  bitmap.close();
  packs.set(url, pack);
  while (packs.size > 6) packs.delete(packs.keys().next().value!);
  return pack;
}

/** Builds the synthetic radar (synthetic-radar.ts) off the main thread. */
addEventListener('message', async (event: MessageEvent<SyntheticRadarRequest>) => {
  const r = event.data;
  try {
    const now = await irOf(r.url, r.minK, r.spanK);
    if (!now) throw new Error('no data pack');
    const history: { ir: Float32Array; minutesAgo: number }[] = [];
    for (const fr of r.history) {
      const p = await irOf(fr.url, r.minK, r.spanK).catch(() => null);
      if (p && p.w === now.w && p.h === now.h) history.push({ ir: p.ir, minutesAgo: fr.minutesAgo });
    }
    packs.delete(r.url); // the newest stays last (kept longest)
    packs.set(r.url, now);
    const out = synthesizeRadar(
      { w: now.w, h: now.h, box: r.box, ir: now.ir, history, wind: r.wind, strikes: r.strikes, radar: r.radar },
      r.config,
    );
    postMessage({ id: r.id, w: out.w, h: out.h, dbz4: out.dbz4, stats: out.stats } satisfies SyntheticRadarResponse, [out.dbz4.buffer]);
  } catch (e) {
    postMessage({ id: r.id, error: String(e) } satisfies SyntheticRadarResponse);
  }
});
