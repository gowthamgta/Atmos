/**
 * Learning the synthetic radar from our own radars (the GREMLIN and IMSRA idea, at our scale). Every look of the nowcast bot, the app pairs
 * what the satellite shows at each 3 km pixel of the data pack with what Chennai or Karaikal saw there at the same time (bot/nowcast.mjs keeps
 * the pairs, pipeline/learn_rain.py fits a model from them). Once the model beats the hand-set rules on days it was not fitted on, the app
 * draws the synthetic radar from it (synthetic-radar.ts) instead of the rules.
 *
 * The inputs are what the papers found to matter, measured the same way everywhere, so the model, not a threshold, decides how much each
 * counts:
 *  - the cloud top and the water-vapour channels (10.8, 6.2 and 7.3 um) and their differences: deep cloud reaches the water-vapour level
 *    (IMSRA, Hydro-Estimator); by day the visible;
 *  - how much the top stands out of the cloud 15 to 25 km around, and how bubbly it is (Hydro-Estimator, the owner's domes);
 *  - the cloud patch it belongs to: how big and how cold, at 250 K and at 273 K, so the model can learn a rain curve for each kind of patch
 *    (PERSIANN-CCS) and the warm-topped showers of the monsoon and the Ghats that a cold threshold misses (IMSRA);
 *  - how fast it cooled over 15 and 30 minutes against where the 850 hPa wind brought it from, whether it cooled more than the cloud around
 *    it, and how its water-vapour difference changed (Mecikalski and Bedka's storm-start signals);
 *  - the anvil's tail along the 250 hPa shear and the leading edge along the 850 hPa wind (the owner's rules), the winds themselves;
 *  - lightning within 10 and 30 km in the last 15 minutes.
 * Places (latitude, longitude) are left out on purpose: the radars see only the south-east, and the model is used over all of India.
 */
import type { MercatorBox, RealRadarInput, StrikeInput, WindGrids } from './synthetic-radar';
import { EARTH_KM, boxSum, latOfMercY, mercY, summed, sunHeightDeg, thirdLeast } from './satellite-grid';

/** The model's inputs, in this order (pipeline/learn_rain.py reads the names). */
export const RAIN_FEATURES = [
  't108', 't62', 't73', 'd108_62', 'd62_73', 'vis', 'sun',
  'ring', 'sigma',
  'cool15', 'cool30', 'coolIso', 'dWv15',
  'tail', 'lead', 'min10', 'mean25',
  'area250', 'min250', 'area273', 'min273',
  'ltg10', 'ltg30',
  'u850', 'v850', 'shear',
] as const;
export type RainFeature = (typeof RAIN_FEATURES)[number];

/** An input that cannot be had there (no earlier frame, night for the visible, ...): below every threshold the trees learn. */
export const MISSING = -999;
/** Pixels with tops at this or colder are looked at (warmer is clear sky or the sea; warm-rain showers top out colder than this). */
export const DOMAIN_MAX_K = 285;

const RING_IN_KM = 15;
const RING_OUT_KM = 25;
const SEARCH_KM = 12;
const LTG_MAX_MIN = 15;
const LTG_TAU_MIN = 8;

export interface RainFeatureInput {
  w: number;
  h: number;
  box: MercatorBox;
  /** 10.8, 6.2 and 7.3 um temperatures (K, 0 = no data). */
  ir: Float32Array;
  wv?: Float32Array | null;
  wv73?: Float32Array | null;
  vis?: Uint8Array | null;
  timeMs?: number;
  history?: { ir: Float32Array; wv?: Float32Array | null; minutesAgo: number }[];
  wind?: WindGrids | null;
  strikes?: readonly StrikeInput[];
}

/** The inputs over the data pack, read a pixel at a time (whole planes of all of them would not fit a phone's memory). */
export interface FeatureField {
  w: number;
  h: number;
  inDomain(i: number): boolean;
  /** The pixel's inputs in RAIN_FEATURES order. */
  fill(i: number, out: Float32Array): void;
  lat(i: number): number;
  lon(i: number): number;
}

const valid = (v: number): boolean => v > 0;

/** The coldest within r pixels (a square min filter, rows then columns); Infinity where there is no data. */
function minFilter(frame: Float32Array, w: number, h: number, r: number): Float32Array {
  const a = new Float32Array(w * h), b = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        const v = frame[y * w + k];
        if (valid(v) && v < m) m = v;
      }
      a[y * w + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (a[k * w + x] < m) m = a[k * w + x];
      b[y * w + x] = m;
    }
  }
  return b;
}

/** The connected patches of tops at maxK or colder: each pixel's patch, and each patch's area (km2) and coldest top. */
function patchesOf(frame: Float32Array, w: number, h: number, rowKm: Float32Array, maxK: number): { label: Int32Array; area: number[]; coldest: number[] } {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const area: number[] = [], coldest: number[] = [];
  const stack: number[] = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (label[s0] >= 0 || !valid(frame[s0]) || frame[s0] > maxK) continue;
    const id = area.length;
    let a = 0, c = Infinity;
    label[s0] = id;
    stack.push(s0);
    while (stack.length) {
      const i = stack.pop()!, x = i % w, y = (i - x) / w;
      a += rowKm[y] * rowKm[y];
      if (frame[i] < c) c = frame[i];
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          const j = yy * w + xx;
          if (label[j] < 0 && valid(frame[j]) && frame[j] <= maxK) {
            label[j] = id;
            stack.push(j);
          }
        }
      }
    }
    area.push(a);
    coldest.push(c);
  }
  return { label, area, coldest };
}

/** The model's inputs over the data pack. */
export function featureField(input: RainFeatureInput, maxTopK = DOMAIN_MAX_K): FeatureField {
  const { w, h, box, ir } = input;
  const n = w * h;
  const x0m = (box.west + 180) / 360;
  const x1m = (box.east + 180) / 360;
  const y0m = mercY(box.north);
  const y1m = mercY(box.south);
  const pxMerc = (x1m - x0m) / w;
  const rowLat = new Float32Array(h);
  const rowKm = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    rowLat[y] = latOfMercY(y0m + ((y + 0.5) / h) * (y1m - y0m));
    rowKm[y] = pxMerc * EARTH_KM * Math.cos((rowLat[y] * Math.PI) / 180);
  }
  const lonOf = (x: number): number => box.west + ((x + 0.5) / w) * (box.east - box.west);
  const midKm = rowKm[h >> 1];

  // window sums: the ground counts as maxTopK (so a dome on its own stands out of it), the texture counts cloud only
  const cloud = (v: number): boolean => valid(v) && v < maxTopK;
  const sumT = summed(ir, w, h, v => (valid(v) ? Math.min(v, maxTopK) : 0));
  const sumN = summed(ir, w, h, v => (valid(v) ? 1 : 0));
  const sumC = summed(ir, w, h, v => (cloud(v) ? 1 : 0));
  const sumTc = summed(ir, w, h, v => (cloud(v) ? v : 0));
  const sumT2c = summed(ir, w, h, v => (cloud(v) ? v * v : 0));
  const boxMean = (cx: number, cy: number, r: number): number => {
    const x0 = Math.round(cx - r), x1 = Math.round(cx + r), y0 = Math.round(cy - r), y1 = Math.round(cy + r);
    const c = boxSum(sumN, w, h, x0, y0, x1, y1);
    return c > 0 ? boxSum(sumT, w, h, x0, y0, x1, y1) / c : NaN;
  };
  const coldest10 = minFilter(ir, w, h, Math.max(1, Math.round(10 / midKm)));

  const wind = input.wind ?? null;
  const windAt = (x: number, y: number): [number, number, number, number] | null => {
    if (!wind) return null;
    const gx = Math.round((lonOf(x) - wind.grid.lonMin) / wind.grid.step);
    const gy = Math.round((wind.grid.latMax - rowLat[y]) / wind.grid.step);
    if (gx < 0 || gy < 0 || gx >= wind.grid.nx || gy >= wind.grid.ny) return null;
    const i = gy * wind.grid.nx + gx;
    const v: [number, number, number, number] = [wind.u850[i], wind.v850[i], wind.u250[i], wind.v250[i]];
    return v.some(Number.isNaN) ? null : v;
  };
  // where the 850 hPa wind brought the cloud at (x, y) from, `minutes` before (pixel index, or -1 off the grid)
  const from = (x: number, y: number, minutes: number): number => {
    const wv = windAt(x, y);
    const u = wv ? wv[0] : 0, v = wv ? wv[1] : 0;
    const fx = Math.round(x - (u * minutes * 60) / 1000 / rowKm[y]);
    const fy = Math.round(y + (v * minutes * 60) / 1000 / rowKm[y]);
    return fx < 0 || fy < 0 || fx >= w || fy >= h ? -1 : fy * w + fx;
  };

  // the frames about 15 and 30 minutes before
  const hist = (input.history ?? []).filter(fr => fr.ir.length === n && fr.minutesAgo > 0);
  const nearest = (target: number, lo: number, hi: number, not?: unknown) =>
    hist.filter(fr => fr.minutesAgo >= lo && fr.minutesAgo <= hi && fr !== not).sort((a, b) => Math.abs(a.minutesAgo - target) - Math.abs(b.minutesAgo - target))[0] ?? null;
  const h15 = nearest(15, 5, 25);
  const h30 = nearest(30, 20, 45, h15);
  const searchR = Math.max(1, Math.round(SEARCH_KM / midKm));
  const cold15 = h15 ? minFilter(h15.ir, w, h, searchR) : null;
  const cold30 = h30 ? minFilter(h30.ir, w, h, searchR) : null;
  // per 15 minutes, against the coldest near where the cloud came from or near the same place (an anvil spreads with the upper wind)
  const cooling = (t: number, x: number, y: number, coldest: Float32Array, minutes: number): number => {
    const j = from(x, y, minutes);
    if (j < 0) return MISSING;
    const c = Math.min(coldest[j], coldest[y * w + x]);
    return c === Infinity ? MISSING : ((Math.min(t, maxTopK) - Math.min(c, maxTopK)) * 15) / Math.max(5, minutes);
  };
  // each pixel's own cooling since h15 (for whether it cooled more than the cloud around it)
  const coolField = h15 ? new Float32Array(n).fill(NaN) : null;
  if (h15 && coolField) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!valid(ir[i])) continue;
        const j = from(x, y, h15.minutesAgo);
        if (j < 0) continue;
        const o = h15.ir[j], same = h15.ir[i];
        const before = valid(o) && valid(same) ? Math.min(o, same) : valid(o) ? o : same;
        if (valid(before)) coolField[i] = ((Math.min(ir[i], maxTopK) - Math.min(before, maxTopK)) * 15) / Math.max(5, h15.minutesAgo);
      }
    }
  }

  const p250 = patchesOf(ir, w, h, rowKm, 250);
  const p273 = patchesOf(ir, w, h, rowKm, 273);

  // lightning, time-weighted, counted per pixel and summed over windows
  const strokes = new Float32Array(n);
  for (const st of input.strikes ?? []) {
    const age = st.ageS / 60;
    if (age < 0 || age > LTG_MAX_MIN) continue;
    const x = Math.floor(((st.lon + 180) / 360 - x0m) / pxMerc);
    const y = Math.floor((mercY(st.lat) - y0m) / pxMerc);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    strokes[y * w + x] += Math.exp(-age / LTG_TAU_MIN);
  }
  const sumL = summed(strokes, w, h, v => v);

  const dirs = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)]);
  const side = new Float64Array(8);
  const t0 = input.timeMs;
  const wv = input.wv ?? null, wv73 = input.wv73 ?? null, vis = input.vis ?? null;

  return {
    w,
    h,
    inDomain: i => valid(ir[i]) && ir[i] <= maxTopK,
    lat: i => rowLat[Math.floor(i / w)],
    lon: i => lonOf(i % w),
    fill(i, out) {
      const x = i % w, y = (i - x) / w, km = rowKm[y];
      const t = ir[i];
      const t62 = wv && valid(wv[i]) ? wv[i] : MISSING;
      const t73 = wv73 && valid(wv73[i]) ? wv73[i] : MISSING;
      const sun = t0 === undefined ? MISSING : sunHeightDeg(t0, rowLat[y], lonOf(x));
      out[0] = t;
      out[1] = t62;
      out[2] = t73;
      out[3] = t62 === MISSING ? MISSING : t - t62;
      out[4] = t62 === MISSING || t73 === MISSING ? MISSING : t62 - t73;
      out[5] = vis && sun !== MISSING && sun >= 10 ? vis[i] : MISSING;
      out[6] = sun;
      // standing out of the ring 15 to 25 km around, in all directions but two
      const rIn = RING_IN_KM / km, rOut = RING_OUT_KM / km, rr = Math.max(1, (RING_OUT_KM - RING_IN_KM) / 4 / km);
      for (let k = 0; k < 8; k++) {
        const [dx, dy] = dirs[k];
        const a = boxMean(x + dx * rIn, y + dy * rIn, rr);
        const b = boxMean(x + dx * rOut, y + dy * rOut, rr);
        const m = Number.isNaN(a) ? b : Number.isNaN(b) ? a : (a + b) / 2;
        side[k] = Number.isNaN(m) ? 0 : m - Math.min(t, maxTopK);
      }
      out[7] = thirdLeast(side);
      const c = boxSum(sumC, w, h, x - 2, y - 2, x + 2, y + 2);
      if (c >= 15) {
        const m1 = boxSum(sumTc, w, h, x - 2, y - 2, x + 2, y + 2) / c;
        const m2 = boxSum(sumT2c, w, h, x - 2, y - 2, x + 2, y + 2) / c;
        out[8] = Math.sqrt(Math.max(0, m2 - m1 * m1));
      } else out[8] = MISSING;
      out[9] = h15 && cold15 ? cooling(t, x, y, cold15, h15.minutesAgo) : MISSING;
      out[10] = h30 && cold30 ? cooling(t, x, y, cold30, h30.minutesAgo) : MISSING;
      // cooling more than the cloud 12 km around in every direction (a tower; a spreading anvil cools along an arc)
      out[11] = MISSING;
      out[12] = MISSING;
      if (h15 && coolField && !Number.isNaN(coolField[i])) {
        let least = Infinity;
        const r = SEARCH_KM / km;
        for (const [dx, dy] of dirs) {
          const xx = Math.round(x + dx * r), yy = Math.round(y + dy * r);
          const v = xx >= 0 && yy >= 0 && xx < w && yy < h ? coolField[yy * w + xx] : NaN;
          least = Math.min(least, Number.isNaN(v) ? 0 : v - coolField[i]);
        }
        out[11] = least;
        const j = from(x, y, h15.minutesAgo);
        if (j >= 0 && t62 !== MISSING && h15.wv && valid(h15.wv[j]) && valid(h15.ir[j])) out[12] = (t62 - t - (h15.wv[j] - h15.ir[j])) * 15 / Math.max(5, h15.minutesAgo);
      }
      const wnd = windAt(x, y);
      out[13] = 0;
      out[14] = 0;
      if (wnd) {
        const [u8, v8, u2, v2] = wnd;
        // an anvil tail: warmer than the cloud upwind along the shear (250 minus 850 hPa; y runs south)
        const su = u2 - u8, sv = -(v2 - v8), ss = Math.hypot(su, sv);
        if (ss > 3) {
          const behind = boxMean(x - (su / ss) * (RING_IN_KM / km), y - (sv / ss) * (RING_IN_KM / km), 1);
          if (!Number.isNaN(behind)) out[13] = Math.min(t, maxTopK) - behind;
        }
        // the leading edge: warmer ahead along the 850 hPa wind
        const ls = Math.hypot(u8, v8);
        if (ls > 1) {
          const ahead = boxMean(x + (u8 / ls) * (9 / km), y - (v8 / ls) * (9 / km), 1);
          if (!Number.isNaN(ahead)) out[14] = ahead - Math.min(t, maxTopK);
        }
        out[23] = u8;
        out[24] = v8;
        out[25] = Math.hypot(u2 - u8, v2 - v8);
      } else {
        out[23] = out[24] = out[25] = MISSING;
      }
      out[15] = coldest10[i] === Infinity ? t : coldest10[i];
      const m25 = boxMean(x, y, 25 / km);
      out[16] = Number.isNaN(m25) ? MISSING : m25;
      const l250 = p250.label[i], l273 = p273.label[i];
      out[17] = l250 >= 0 ? Math.log10(1 + p250.area[l250]) : 0;
      out[18] = l250 >= 0 ? p250.coldest[l250] : MISSING;
      out[19] = l273 >= 0 ? Math.log10(1 + p273.area[l273]) : 0;
      out[20] = l273 >= 0 ? p273.coldest[l273] : MISSING;
      const r10 = Math.round(10 / km), r30 = Math.round(30 / km);
      out[21] = boxSum(sumL, w, h, x - r10, y - r10, x + r10, y + r10);
      out[22] = boxSum(sumL, w, h, x - r30, y - r30, x + r30, y + r30);
    },
  };
}

// ── Pairs: the satellite's inputs against what the radar saw ───────────────────────────────────────────────────────────────────────────

/** The real radar picture at a time (the live picture or a step of the last hour's loop). */
export interface PairRadar extends RealRadarInput {
  timeMs: number;
}

export const PAIR_OPTIONS = {
  /** Only this far from a radar: closer is ground clutter, farther the beam passes over the rain. */
  minRangeKm: 20,
  maxRangeKm: 250,
  /** A pixel with an echo of this or more somewhere in it is rainy. */
  rainDbz: 15,
  /** At most this many rainy and dry pixels a look (the rest are sampled, each kept one weighed for those it stands for). */
  maxRainy: 2000,
  maxDry: 800,
};

/** Kept beside the inputs, not learned from. */
export const PAIR_META = ['lat', 'lon', 'rangeKm', 'dbzMax', 'dbzMeanZ', 'hand', 'weight'] as const;

export interface RainPairs {
  satTimeMs: number;
  radarTimeMs: number;
  features: string[];
  meta: string[];
  rows: number;
  /** Column by name (features then meta), rounded. */
  cols: Record<string, number[]>;
  counts: { domain: number; covered: number; rainy: number; rainOutside: number };
}

/** The hand-set rules' picture (synthetic-radar.ts, before it was shifted to match the radar), for scoring the model against them. */
export interface HandRain {
  dbz4: Uint8Array;
  w: number;
  h: number;
  offsetDb: number;
}

/** A small seeded random generator (so a look's sample can be made again). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The pairs of one look: every pixel of the data pack a working radar sees well, its inputs and the radar's reflectivity there. */
export function collectPairs(input: RainFeatureInput, radar: PairRadar, satTimeMs: number, hand: HandRain | null, opts = PAIR_OPTIONS): RainPairs {
  const field = featureField(input);
  const { w, h, box } = input;
  const x0m = (box.west + 180) / 360, x1m = (box.east + 180) / 360;
  const y0m = mercY(box.north), y1m = mercY(box.south);
  const pxX = (x1m - x0m) / w, pxY = (y1m - y0m) / h;
  const rx0 = (radar.box.west + 180) / 360, rx1 = (radar.box.east + 180) / 360;
  const ry0 = mercY(radar.box.north), ry1 = mercY(radar.box.south);
  const S = hand ? Math.max(1, Math.round(hand.w / w)) : 1;

  /** The radar over a data pixel: its strongest echo and the reflectivity of its mean Z (no echo counts as none), or null off the picture. */
  const sample = (x: number, y: number): [number, number] | null => {
    const u0 = Math.floor(((x0m + x * pxX - rx0) / (rx1 - rx0)) * radar.width);
    const u1 = Math.ceil(((x0m + (x + 1) * pxX - rx0) / (rx1 - rx0)) * radar.width) - 1;
    const v0 = Math.floor(((y0m + y * pxY - ry0) / (ry1 - ry0)) * radar.height);
    const v1 = Math.ceil(((y0m + (y + 1) * pxY - ry0) / (ry1 - ry0)) * radar.height) - 1;
    if (u0 < 0 || v0 < 0 || u1 >= radar.width || v1 >= radar.height) return null;
    let max = 0, z = 0, k = 0;
    for (let v = v0; v <= Math.max(v0, v1); v++) {
      for (let u = u0; u <= Math.max(u0, u1); u++) {
        const b = radar.field[v * radar.width + u];
        k++;
        if (!b) continue;
        const dbz = 12 + 9.6 * ((b * radar.maxIntensity) / 255);
        if (dbz > max) max = dbz;
        z += 10 ** (dbz / 10);
      }
    }
    return [max, z > 0 ? 10 * Math.log10(z / k) : 0];
  };
  const rangeTo = (lat: number, lon: number): number => {
    let best = Infinity;
    for (const d of radar.discs) {
      const dx = (lon - d.lng) * 111.32 * Math.cos((((lat + d.lat) / 2) * Math.PI) / 180);
      const dy = (lat - d.lat) * 110.57;
      const r = Math.hypot(dx, dy);
      if (r <= d.rangeKm && r < best) best = r;
    }
    return best;
  };

  const rnd = mulberry32(Math.floor(satTimeMs / 60_000));
  // reservoir samples of the rainy and the dry pixels
  const rainy: { i: number; r: number; s: [number, number] }[] = [], dry: typeof rainy = [];
  let nRainy = 0, nDry = 0, domain = 0, rainOutside = 0;
  const keep = (list: typeof rainy, seen: number, cap: number, item: (typeof rainy)[number]) => {
    if (list.length < cap) list.push(item);
    else {
      const j = Math.floor(rnd() * seen);
      if (j < cap) list[j] = item;
    }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = rangeTo(field.lat(i), field.lon(i));
      if (r < opts.minRangeKm || r > opts.maxRangeKm) continue;
      const s = sample(x, y);
      if (!s) continue;
      const wet = s[0] >= opts.rainDbz;
      if (!field.inDomain(i)) {
        if (wet && input.ir[i] > 0) rainOutside++;
        continue;
      }
      domain++;
      if (wet) keep(rainy, ++nRainy, opts.maxRainy, { i, r, s });
      else keep(dry, ++nDry, opts.maxDry, { i, r, s });
    }
  }

  const names = [...RAIN_FEATURES] as string[];
  const cols: Record<string, number[]> = {};
  for (const k of [...names, ...PAIR_META]) cols[k] = [];
  const x = new Float32Array(RAIN_FEATURES.length);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const handAt = (i: number): number => {
    if (!hand) return MISSING;
    const px = i % w, py = (i - px) / w;
    let m = 0;
    for (let yy = py * S; yy < Math.min(hand.h, (py + 1) * S); yy++) for (let xx = px * S; xx < Math.min(hand.w, (px + 1) * S); xx++) m = Math.max(m, hand.dbz4[yy * hand.w + xx] / 4);
    return m > 0 ? Math.max(0, m - hand.offsetDb) : 0;
  };
  for (const [list, total] of [[rainy, nRainy], [dry, nDry]] as const) {
    const weight = list.length ? total / list.length : 0;
    for (const p of list) {
      field.fill(p.i, x);
      names.forEach((k, f) => cols[k].push(r1(x[f])));
      cols['lat'].push(Math.round(field.lat(p.i) * 1000) / 1000);
      cols['lon'].push(Math.round(field.lon(p.i) * 1000) / 1000);
      cols['rangeKm'].push(Math.round(p.r));
      cols['dbzMax'].push(r1(p.s[0]));
      cols['dbzMeanZ'].push(r1(p.s[1]));
      cols['hand'].push(r1(handAt(p.i)));
      cols['weight'].push(Math.round(weight * 100) / 100);
    }
  }
  return {
    satTimeMs,
    radarTimeMs: radar.timeMs,
    features: names,
    meta: [...PAIR_META],
    rows: rainy.length + dry.length,
    cols,
    counts: { domain, covered: nRainy + nDry, rainy: nRainy, rainOutside },
  };
}

// ── The learned model ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Gradient-boosted trees, flattened (pipeline/learn_rain.py): f the input of each node (-1: a leaf), t its threshold (x <= t goes left),
 * l and r its children, v a leaf's value. The sum is base + lr x the leaves reached. */
export interface RainTrees {
  base: number;
  lr: number;
  trees: { f: number[]; t: number[]; l: number[]; r: number[]; v: number[] }[];
}

/** public/data/rain-model.json: whether there is rain (a log-odds), and how much where there is (dBZ). */
export interface RainModel {
  version: 1;
  features: string[];
  /** Beats the hand-set rules on held-back days (pipeline/learn_rain.py): only then is it drawn. */
  approved: boolean;
  maxTopK: number;
  /** Rain where its chance is at least this (chosen so the model draws about as much rain as the radar sees). */
  rainProb: number;
  minDbz: number;
  maxDbz: number;
  rain: RainTrees;
  dbz: RainTrees;
  fitted?: string;
  scores?: Record<string, unknown>;
}

export function treesValue(m: RainTrees, x: ArrayLike<number>): number {
  let s = m.base;
  for (const tr of m.trees) {
    let k = 0;
    while (tr.f[k] >= 0) k = x[tr.f[k]] <= tr.t[k] ? tr.l[k] : tr.r[k];
    s += m.lr * tr.v[k];
  }
  return s;
}

/** Where each of the model's inputs is in RAIN_FEATURES, or null when the model cannot be used (another version, an unknown input). */
export function modelOrder(model: RainModel | null | undefined): Int32Array | null {
  if (!model || model.version !== 1 || !model.rain?.trees || !model.dbz?.trees) return null;
  const order = model.features.map(f => (RAIN_FEATURES as readonly string[]).indexOf(f));
  return order.some(k => k < 0) ? null : Int32Array.from(order);
}

/** The model's reflectivity for one pixel's inputs (in the model's order); 0: no rain. */
export function predictDbz(model: RainModel, x: ArrayLike<number>): number {
  const p = 1 / (1 + Math.exp(-treesValue(model.rain, x)));
  if (p < model.rainProb) return 0;
  return Math.min(model.maxDbz, Math.max(model.minDbz, treesValue(model.dbz, x)));
}

/** A pixel whose rain chance on the coarse pass is under this share of the model's threshold, at every coarse neighbour, is left dry. */
const COARSE_SHARE = 0.5;

/** The model's rain over the data pack (dBZ per pixel, 0: none), or null when it cannot be used. Most of the map is dry, so the chance of rain
 * is first worked out at every other pixel each way, and in full only around those anywhere near raining (about a quarter of the work in dry
 * country, the same picture where it rains: a cell is wider than the 6 km between coarse pixels). */
export function learnedRain(input: RainFeatureInput, model: RainModel): Float32Array | null {
  const order = modelOrder(model);
  if (!order) return null;
  const field = featureField(input, model.maxTopK);
  const { w, h } = input;
  const out = new Float32Array(w * h);
  const all = new Float32Array(RAIN_FEATURES.length);
  const x = new Float32Array(order.length);
  const load = (i: number): void => {
    field.fill(i, all);
    for (let k = 0; k < order.length; k++) x[k] = all[order[k]];
  };
  const chance = (i: number): number => {
    load(i);
    return 1 / (1 + Math.exp(-treesValue(model.rain, x)));
  };
  // the coarse pass (NaN: not looked at, out of the domain)
  const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
  const coarse = new Float32Array(cw * ch).fill(NaN);
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    const i = 2 * cy * w + 2 * cx;
    if (field.inDomain(i)) coarse[cy * cw + cx] = chance(i);
  }
  const near = model.rainProb * COARSE_SHARE;
  for (let y = 0; y < h; y++) {
    const cy0 = y >> 1, cy1 = Math.min(ch - 1, (y + 1) >> 1);
    for (let xx = 0; xx < w; xx++) {
      const i = y * w + xx;
      if (!field.inDomain(i)) continue;
      const cx0 = xx >> 1, cx1 = Math.min(cw - 1, (xx + 1) >> 1);
      // the coarse neighbours (NaN compares false both ways: an unseen one counts as neither dry nor wet)
      const a = coarse[cy0 * cw + cx0], b = coarse[cy0 * cw + cx1], c = coarse[cy1 * cw + cx0], d = coarse[cy1 * cw + cx1];
      const dry = a < near || b < near || c < near || d < near;
      if (dry && !(a >= near || b >= near || c >= near || d >= near)) continue;
      const own = (y & 1) === 0 && (xx & 1) === 0 ? coarse[cy0 * cw + cx0] : NaN;
      const p = Number.isNaN(own) ? chance(i) : (load(i), own);
      if (p < model.rainProb) continue;
      out[i] = Math.min(model.maxDbz, Math.max(model.minDbz, treesValue(model.dbz, x)));
    }
  }
  return out;
}
