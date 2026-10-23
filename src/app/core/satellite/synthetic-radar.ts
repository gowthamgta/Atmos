/**
 * Synthetic radar: the rain a radar would see where no working radar does, read from our own Meteosat data pack (measured 10.8 and 6.2 um
 * cloud-top temperatures, about 3 km a pixel), the frame 15 minutes before it, ILDN lightning and the forecast 850 and 250 hPa winds, the way
 * a forecaster reads the satellite:
 *
 * 1. Flat high cloud (cirrus, anvils blown off by the upper wind) is not rain, however cold. Rain is under a dome: a top colder than the
 *    cloud 15 to 25 km around it on both sides of some line through it (an anvil's edge is colder than the clear sky on one side only, so it
 *    is no dome), and bubbly (the temperatures' spread over 5 x 5 pixels). An anvil tail warming downwind along the 250 hPa wind (relative to
 *    the 850 hPa wind) from a colder core is worn away; the side the low cloud moves to (850 hPa) is the leading edge and gets the rain.
 * 2. New popups: a cloud colder than anything near the place it came from 15 minutes before (moved with the 850 hPa wind) by 4 K or more.
 *    The rain cells are grouped and drawn by size: small popups a tight core of 20 to 28 dBZ, medium cells 28 to 36 dBZ toward the low-level
 *    wind tapering to 18 to 24 dBZ, large ones only along their colder sub-cores and ridge lines (bands, not a solid fill).
 * 3. Lightning (last 15 minutes, newer weighed more) marks the heavy cores: 45 to 55+ dBZ within about 5 km, 35 to 44 within about 12 km,
 *    shaped by the cloud (its coldness and its edges), never on clear sky.
 * 4. Where Chennai or Karaikal see, the real radar is drawn (the layer fades the estimate out over the last 20 km of their range), and
 *    where both see rain the estimate is shifted by the median difference (a few dB at most) so it joins the radar without a step.
 *
 * Everything that can be tuned is in SYNTHETIC_RADAR_CONFIG (live, from the browser console: atmosSyntheticRadar.set({...})).
 */

/** All thresholds. Temperatures in kelvin, distances in km, reflectivity in dBZ. */
export interface SyntheticRadarConfig {
  cloud: {
    /** Warmer than this is low cloud or ground (yellow in the infrared): never rain here (and the ring counts the ground as this warm). */
    topK: number;
    /** A rain cell's pixels are colder than this (a low cloud popping up is white by then)... */
    cellMaxK: number;
    /** ...and its coldest pixel colder than this: yellow low cloud next to clear ground is no rain cell (lightning aside). */
    coreMaxK: number;
  };
  anvil: {
    /** The ring the dome is measured against. */
    ringInnerKm: number;
    ringOuterKm: number;
    /** Colder than the ring by less than this: flat (anvil, cirrus, stratiform). */
    ringDiffMinK: number;
    /** Colder by this or more: a full dome. */
    ringDiffFullK: number;
    /** Spread of the temperatures over 5 x 5 pixels below which the cloud is smooth (cirrus), and above which it is fully bubbly. */
    textureMinK: number;
    textureFullK: number;
    /** How far upwind along the shear an anvil tail's core is looked for. */
    upshearKm: number;
    /** Warmer than that core by this much (start, full): a tail. */
    tailWarmK: [number, number];
    /** How much of a tail is worn away (0 to 1). */
    erosion: number;
    /** How far ahead along the 850 hPa wind the leading edge is looked for, and the warming there that counts as a sharp edge. */
    leadKm: number;
    leadEdgeK: [number, number];
    /** Extra score at a sharp leading edge (fraction). */
    leadBoost: number;
  };
  popup: {
    /** Colder than 15 minutes before by this much (start, full): a new popup. */
    coolingK: [number, number];
    /** Where the cloud may have been 15 minutes before: this far around the place the 850 hPa wind brought it from. */
    searchKm: number;
  };
  size: {
    /** Effective radius (sqrt(area / pi)) below which a cell is a small popup, above which a large band. */
    smallKm: number;
    largeKm: number;
    small: [number, number];
    medium: [number, number];
    mediumEdge: [number, number];
    large: [number, number];
    /** The core covers about this fraction of the cell. */
    coreFraction: number;
    /** The core sits this fraction of the radius toward where the 850 hPa wind goes. */
    inflowShift: number;
    /** Large bands: the sub-cores are this much colder than the cloud within subcoreBoxKm. */
    subcoreBoxKm: number;
    subcoreDepthK: number;
  };
  lightning: {
    /** Weight of a stroke: exp(-age / tauMin), none after maxAgeMin. */
    tauMin: number;
    maxAgeMin: number;
    /** Gaussian radii of the heavy core and of the convective envelope. */
    coreKm: number;
    envelopeKm: number;
    envelopeWeight: number;
    core: [number, number];
    envelope: [number, number];
    /** Shaped density from which a core, or an envelope, is drawn. */
    coreThreshold: number;
    envelopeThreshold: number;
    /** Cloud-top temperature gradient (K/km) of a fully sharp edge. */
    edgeKPerKm: number;
  };
  output: {
    /** Pixels scoring below this are not rain. */
    minScore: number;
    minDbz: number;
    maxDbz: number;
  };
  blend: {
    /** The estimate fades out over this last stretch of a working radar's range. */
    featherKm: number;
    /** Calibration against the radar where both see rain: at most this shift, from at least this many pixels. */
    calibrationMaxDb: number;
    calibrationMinPairs: number;
  };
}

export const SYNTHETIC_RADAR_CONFIG: SyntheticRadarConfig = {
  cloud: { topK: 278.3, cellMaxK: 258, coreMaxK: 248 },
  anvil: {
    ringInnerKm: 15,
    ringOuterKm: 25,
    ringDiffMinK: 3.5,
    ringDiffFullK: 10,
    textureMinK: 1.2,
    textureFullK: 4.5,
    upshearKm: 15,
    tailWarmK: [1.5, 6],
    erosion: 0.85,
    leadKm: 9,
    leadEdgeK: [2, 10],
    leadBoost: 0.25,
  },
  popup: { coolingK: [4, 10], searchKm: 6 },
  size: {
    smallKm: 4,
    largeKm: 12,
    small: [20, 28],
    medium: [28, 36],
    mediumEdge: [18, 24],
    large: [26, 40],
    coreFraction: 0.6,
    inflowShift: 0.3,
    subcoreBoxKm: 9,
    subcoreDepthK: 6,
  },
  lightning: {
    tauMin: 8,
    maxAgeMin: 15,
    coreKm: 5,
    envelopeKm: 12,
    envelopeWeight: 0.45,
    core: [45, 56],
    envelope: [35, 44],
    coreThreshold: 0.45,
    envelopeThreshold: 0.1,
    edgeKPerKm: 3,
  },
  output: { minScore: 0.25, minDbz: 15, maxDbz: 60 },
  blend: { featherKm: 20, calibrationMaxDb: 8, calibrationMinPairs: 150 },
};

/** A copy of the config with some values changed (nested objects merged). */
export function tuneConfig(base: SyntheticRadarConfig, patch: DeepPartial<SyntheticRadarConfig>): SyntheticRadarConfig {
  const out = structuredClone(base) as unknown as Record<string, Record<string, unknown>>;
  for (const [group, values] of Object.entries(patch ?? {})) {
    if (!(group in out) || !values) continue;
    Object.assign(out[group], values);
  }
  return out as unknown as SyntheticRadarConfig;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** What is known at one pixel (the grid code below measures it; classifyPixel decides). */
export interface PixelFeatures {
  /** Cloud-top temperature (10.8 um). 0 or NaN: no data. */
  tK: number;
  /** How much colder than the ring 15 to 25 km around the pixel is, in all directions but two (the third least of eight). */
  ringDiffK: number;
  /** Spread of the temperatures over 5 x 5 pixels. */
  sigmaK: number;
  /** Colder now than anything near where the cloud was 15 minutes before (negative = cooled); NaN without that frame. */
  coolingK: number;
  /** tK minus the cloud upwind along the shear (positive: warmer than a core behind it, a tail). */
  tailK: number;
  /** The cloud ahead along the 850 hPa wind minus tK (positive: a sharp leading edge). */
  leadK: number;
  /** The cell this pixel is in: effective radius, best score, where in it the core is (1 at the core) and how far in from its edge (1 on its ridge). */
  cellRadiusKm: number;
  cellScore: number;
  coreProfile: number;
  ridge: number;
  /** The cloud within subcoreBoxKm minus tK (positive: a sub-core of a band). */
  subcoreK: number;
  /** Lightning density at the heavy-core and envelope radii (time-weighted). */
  lightningCore: number;
  lightningEnvelope: number;
  /** Cloud-top temperature gradient, K/km. */
  gradientKPerKm: number;
}

export type PixelCategory = 'none' | 'anvil' | 'popup' | 'cell' | 'band' | 'lightning';

export interface PixelResult {
  dbz: number;
  category: PixelCategory;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = ([a, b]: readonly [number, number], t: number): number => a + (b - a) * Math.min(1, Math.max(0, t));

/** How likely a pixel is to be under a rain cell (0 to 1), from rules 1 and 2. */
export function convectiveScore(f: PixelFeatures, cfg: SyntheticRadarConfig = SYNTHETIC_RADAR_CONFIG): number {
  if (!(f.tK > 0) || f.tK >= cfg.cloud.cellMaxK) return 0;
  const a = cfg.anvil;
  const dome = smooth(a.ringDiffMinK, a.ringDiffFullK, f.ringDiffK);
  const texture = smooth(a.textureMinK, a.textureFullK, f.sigmaK);
  const grow = Number.isFinite(f.coolingK) ? smooth(cfg.popup.coolingK[0], cfg.popup.coolingK[1], -f.coolingK) : 0;
  if (dome === 0 && texture === 0 && grow === 0) return 0; // flat and smooth: anvil or cirrus
  const tail = 1 - a.erosion * smooth(a.tailWarmK[0], a.tailWarmK[1], f.tailK) * (1 - dome);
  const lead = 1 + a.leadBoost * smooth(a.leadEdgeK[0], a.leadEdgeK[1], f.leadK);
  return Math.min(1, Math.max(dome * (0.55 + 0.45 * texture), grow) * tail * lead);
}

/** The lightning density shaped by the cloud: cold cloud and its sharp edges carry it, clear sky none. */
export function shapedLightning(f: PixelFeatures, score: number, cfg: SyntheticRadarConfig = SYNTHETIC_RADAR_CONFIG): number {
  if (!(f.tK > 0) || f.tK >= cfg.cloud.topK) return 0;
  const l = cfg.lightning;
  const density = f.lightningCore + l.envelopeWeight * f.lightningEnvelope;
  if (density <= 0) return 0;
  const cold = smooth(0, 40, cfg.cloud.topK - f.tK);
  const edge = Math.min(1, f.gradientKPerKm / l.edgeKPerKm);
  return density * cold * (0.4 + 0.6 * Math.max(score, edge));
}

/**
 * The reflectivity a radar would see at a pixel (rules 1 to 3). The cell measures (radius, core, ridge) come from grouping the pixels that
 * score as rain; a pixel that is in no cell has cellRadiusKm 0.
 */
export function classifyPixel(f: PixelFeatures, cfg: SyntheticRadarConfig = SYNTHETIC_RADAR_CONFIG): PixelResult {
  const score = convectiveScore(f, cfg);
  const lightning = shapedLightning(f, score, cfg);
  const l = cfg.lightning;
  const s = cfg.size;
  let dbz = 0;
  let category: PixelCategory = 'none';
  if (score >= cfg.output.minScore && f.cellRadiusKm > 0) {
    if (f.cellRadiusKm < s.smallKm) {
      const peak = lerp(s.small, f.cellScore);
      dbz = 12 + (peak - 12) * f.coreProfile;
      category = 'popup';
    } else if (f.cellRadiusKm <= s.largeKm) {
      const peak = lerp(s.medium, f.cellScore);
      const edge = lerp(s.mediumEdge, score);
      dbz = edge + (peak - edge) * f.coreProfile;
      category = 'cell';
    } else {
      // a band: rain along its colder sub-cores and its ridge, not the whole cloud
      const w = Math.max(smooth(0, s.subcoreDepthK, f.subcoreK), 0.75 * smooth(0.35, 0.85, f.ridge)) * score;
      if (w > 0.12) {
        dbz = lerp(s.large, w);
        category = 'band';
      }
    }
  } else if (score === 0 && f.tK > 0 && f.tK < cfg.cloud.topK) {
    category = 'anvil';
  }
  if (lightning >= l.coreThreshold) {
    dbz = Math.max(dbz, lerp(l.core, (lightning - l.coreThreshold) / l.coreThreshold));
    category = 'lightning';
  } else if (lightning >= l.envelopeThreshold) {
    const e = lerp(l.envelope, (lightning - l.envelopeThreshold) / (l.coreThreshold - l.envelopeThreshold));
    if (e > dbz) {
      dbz = e;
      category = 'lightning';
    }
  }
  if (dbz < cfg.output.minDbz) return { dbz: 0, category: category === 'anvil' ? 'anvil' : 'none' };
  return { dbz: Math.min(cfg.output.maxDbz, dbz), category };
}

/** The radar's colour of a reflectivity, as the radar layer draws it (intensity v = (dBZ - 12) / 9.6). */
export const dbzToIntensity = (dbz: number): number => (dbz <= 12 ? 0 : (dbz - 12) / 9.6);

// ── The grid ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MercatorBox {
  west: number;
  east: number;
  south: number;
  north: number;
}

/** The forecast winds on their grid (gridPosition in forecast.model.ts: rows from latMax down), m/s east and north. */
export interface WindGrids {
  grid: { latMax: number; lonMin: number; step: number; nx: number; ny: number };
  u850: Float32Array;
  v850: Float32Array;
  u250: Float32Array;
  v250: Float32Array;
}

export interface StrikeInput {
  lat: number;
  lon: number;
  ageS: number;
}

/** The real radar picture (the radar layer's mosaic: one byte of intensity per pixel, over a Mercator box). */
export interface RealRadarInput {
  field: Uint8Array;
  width: number;
  height: number;
  box: MercatorBox;
  /** Intensity of byte 255 (RADAR_FIELD_MAX). */
  maxIntensity: number;
  /** The radars' discs (centre, range): pairs are taken only inside them. */
  discs: { lat: number; lng: number; rangeKm: number }[];
}

export interface SyntheticRadarInput {
  w: number;
  h: number;
  box: MercatorBox;
  /** Cloud-top temperatures (K, 0 = no data): 10.8 um now, and 15 minutes before (optional). */
  ir: Float32Array;
  irPrev?: Float32Array | null;
  /** Minutes between the two frames. */
  prevMinutes?: number;
  wind?: WindGrids | null;
  strikes?: readonly StrikeInput[];
  radar?: RealRadarInput | null;
}

export interface SyntheticRadarStats {
  cells: number;
  popups: number;
  lightningCores: number;
  /** The shift applied to match the real radar (dB), and from how many pixels. */
  offsetDb: number;
  pairs: number;
  usedPrevious: boolean;
  /** Lightning strokes over the grid. */
  strikes: number;
  ms: number;
}

export interface SyntheticRadarOutput {
  /** Reflectivity x 4 per pixel (0: none), row-major over the same box as the input. */
  dbz4: Uint8Array;
  stats: SyntheticRadarStats;
}

const EARTH_KM = 40_075.017;
const mercY = (lat: number): number => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const latOfMercY = (y: number): number => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/** Summed-area table (one row and column of zeros in front). */
function summed(values: Float32Array, w: number, h: number, map: (v: number) => number): Float64Array {
  const t = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += map(values[y * w + x]);
      t[(y + 1) * (w + 1) + x + 1] = t[y * (w + 1) + x + 1] + row;
    }
  }
  return t;
}

function boxSum(t: Float64Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): number {
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(w - 1, x1);
  y1 = Math.min(h - 1, y1);
  if (x1 < x0 || y1 < y0) return 0;
  const W = w + 1;
  return t[(y1 + 1) * W + x1 + 1] - t[y0 * W + x1 + 1] - t[(y1 + 1) * W + x0] + t[y0 * W + x0];
}

/** The third least of eight values. */
function thirdLeast(v: Float64Array): number {
  let a = Infinity, b = Infinity, c = Infinity;
  for (let k = 0; k < 8; k++) {
    const x = v[k];
    if (x < a) [a, b, c] = [x, a, b];
    else if (x < b) [b, c] = [x, b];
    else if (x < c) c = x;
  }
  return c;
}

/** The synthetic radar over the data pack's grid (rules 1 to 4). */
export function synthesizeRadar(input: SyntheticRadarInput, cfg: SyntheticRadarConfig = SYNTHETIC_RADAR_CONFIG): SyntheticRadarOutput {
  const started = performance.now();
  const { w, h, box, ir } = input;
  const n = w * h;
  const topK = cfg.cloud.topK;
  const x0m = (box.west + 180) / 360;
  const x1m = (box.east + 180) / 360;
  const y0m = mercY(box.north);
  const y1m = mercY(box.south);
  const pxMerc = (x1m - x0m) / w; // square pixels in Mercator
  // per row: latitude and km per pixel
  const rowLat = new Float32Array(h);
  const rowKm = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    rowLat[y] = latOfMercY(y0m + ((y + 0.5) / h) * (y1m - y0m));
    rowKm[y] = pxMerc * EARTH_KM * Math.cos((rowLat[y] * Math.PI) / 180);
  }
  const lonOf = (x: number): number => box.west + ((x + 0.5) / w) * (box.east - box.west);

  const valid = (v: number): boolean => v > 0;
  const sumT = summed(ir, w, h, v => (valid(v) ? Math.min(v, topK) : 0));
  const sumT2 = summed(ir, w, h, v => (valid(v) ? Math.min(v, topK) ** 2 : 0));
  const sumN = summed(ir, w, h, v => (valid(v) ? 1 : 0));
  const boxMean = (cx: number, cy: number, r: number): number => {
    const x0 = Math.round(cx - r), x1 = Math.round(cx + r), y0 = Math.round(cy - r), y1 = Math.round(cy + r);
    const c = boxSum(sumN, w, h, x0, y0, x1, y1);
    return c > 0 ? boxSum(sumT, w, h, x0, y0, x1, y1) / c : NaN;
  };

  // winds (nearest forecast grid point) in pixels: x east, y south
  const windAt = (x: number, y: number): [number, number, number, number] => {
    const wg = input.wind;
    if (!wg) return [0, 0, 0, 0];
    const gx = Math.round((lonOf(x) - wg.grid.lonMin) / wg.grid.step);
    const gy = Math.round((wg.grid.latMax - rowLat[y]) / wg.grid.step);
    if (gx < 0 || gy < 0 || gx >= wg.grid.nx || gy >= wg.grid.ny) return [0, 0, 0, 0];
    const i = gy * wg.grid.nx + gx;
    const v = [wg.u850[i], wg.v850[i], wg.u250[i], wg.v250[i]];
    return v.some(Number.isNaN) ? [0, 0, 0, 0] : (v as [number, number, number, number]);
  };

  // rule 3: the lightning density, time-weighted, at two radii
  const lcore = new Float32Array(n);
  const lenv = new Float32Array(n);
  let strikesUsed = 0;
  for (const s of input.strikes ?? []) {
    const age = s.ageS / 60;
    if (age < 0 || age > cfg.lightning.maxAgeMin) continue;
    const sx = ((s.lon + 180) / 360 - x0m) / pxMerc - 0.5;
    const sy = (mercY(s.lat) - y0m) / pxMerc - 0.5;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    strikesUsed++;
    const km = rowKm[Math.min(h - 1, Math.max(0, Math.round(sy)))];
    const wt = Math.exp(-age / cfg.lightning.tauMin);
    const sc = cfg.lightning.coreKm / km;
    const se = cfg.lightning.envelopeKm / km;
    const r = Math.ceil(se * 2.5);
    for (let y = Math.max(0, Math.floor(sy - r)); y <= Math.min(h - 1, Math.ceil(sy + r)); y++) {
      for (let x = Math.max(0, Math.floor(sx - r)); x <= Math.min(w - 1, Math.ceil(sx + r)); x++) {
        const d2 = (x - sx) ** 2 + (y - sy) ** 2;
        const i = y * w + x;
        lcore[i] += wt * Math.exp(-d2 / (2 * sc * sc));
        lenv[i] += wt * Math.exp(-d2 / (2 * se * se));
      }
    }
  }

  // rules 1 and 2, pixel by pixel: the features that do not need the cells
  const feats = {
    ring: new Float32Array(n),
    sigma: new Float32Array(n),
    cooling: new Float32Array(n).fill(NaN),
    tail: new Float32Array(n),
    lead: new Float32Array(n),
    grad: new Float32Array(n),
    sub: new Float32Array(n),
  };
  const score = new Float32Array(n);
  const prev = input.irPrev ?? null;
  const prevScale = 15 / Math.max(5, input.prevMinutes ?? 15);
  // the cloud averaged over the ring's width (a quarter of it each way), once: the ring is then read at 16 points
  const blur = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const r = Math.max(1, (cfg.anvil.ringOuterKm - cfg.anvil.ringInnerKm) / 4 / rowKm[y]);
    for (let x = 0; x < w; x++) blur[y * w + x] = boxMean(x, y, r);
  }
  const blurAt = (x: number, y: number): number => {
    const xi = Math.round(x), yi = Math.round(y);
    return xi < 0 || yi < 0 || xi >= w || yi >= h ? NaN : blur[yi * w + xi];
  };
  const side = new Float64Array(8);
  const dirs = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)]);
  const f: PixelFeatures = {
    tK: 0, ringDiffK: 0, sigmaK: 0, coolingK: NaN, tailK: 0, leadK: 0, cellRadiusKm: 0, cellScore: 0, coreProfile: 0, ridge: 0, subcoreK: 0,
    lightningCore: 0, lightningEnvelope: 0, gradientKPerKm: 0,
  };
  for (let y = 0; y < h; y++) {
    const km = rowKm[y];
    const rIn = cfg.anvil.ringInnerKm / km;
    const rOut = cfg.anvil.ringOuterKm / km;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = ir[i];
      if (!valid(t) || t >= topK) continue;
      // the dome: colder than the ring in all directions but two (a band is cold along its own line; the rim of a cold mass has three or
      // more cold directions, toward its middle)
      for (let k = 0; k < 8; k++) {
        const [dx, dy] = dirs[k];
        const a = blurAt(x + dx * rIn, y + dy * rIn);
        const b = blurAt(x + dx * rOut, y + dy * rOut);
        const m = Number.isNaN(a) ? b : Number.isNaN(b) ? a : (a + b) / 2;
        side[k] = Number.isNaN(m) ? 0 : m - t;
      }
      const ring = thirdLeast(side);
      feats.ring[i] = ring;
      const c = boxSum(sumN, w, h, x - 2, y - 2, x + 2, y + 2);
      const m1 = boxSum(sumT, w, h, x - 2, y - 2, x + 2, y + 2) / c;
      const m2 = boxSum(sumT2, w, h, x - 2, y - 2, x + 2, y + 2) / c;
      feats.sigma[i] = Math.sqrt(Math.max(0, m2 - m1 * m1));
      // the gradient (K/km)
      const gx = (boxMean(x + 1, y, 0) - boxMean(x - 1, y, 0)) / (2 * km);
      const gy = (boxMean(x, y + 1, 0) - boxMean(x, y - 1, 0)) / (2 * km);
      feats.grad[i] = Number.isNaN(gx + gy) ? 0 : Math.hypot(gx, gy);
      // the winds: the shear (250 minus 850 hPa) and the low cloud's motion, as unit vectors on the grid (y down)
      const [u8, v8, u2, v2] = windAt(x, y);
      const su = u2 - u8, sv = -(v2 - v8);
      const ss = Math.hypot(su, sv);
      if (ss > 3) {
        const up = cfg.anvil.upshearKm / km;
        const behind = boxMean(x - (su / ss) * up, y - (sv / ss) * up, 1);
        feats.tail[i] = Number.isNaN(behind) ? 0 : t - behind;
      }
      const ls = Math.hypot(u8, v8);
      if (ls > 1) {
        const ahead = cfg.anvil.leadKm / km;
        const a = boxMean(x + (u8 / ls) * ahead, y - (v8 / ls) * ahead, 1);
        feats.lead[i] = Number.isNaN(a) ? 0 : a - t;
      }
      // rule 2: colder than anything near where the cloud was a frame before
      if (prev) {
        const minutes = (input.prevMinutes ?? 15) * 60;
        const fx = Math.round(x - (u8 * minutes) / 1000 / km);
        const fy = Math.round(y + (v8 * minutes) / 1000 / km);
        const r = Math.max(1, Math.round(cfg.popup.searchKm / km));
        let coldest = Infinity;
        for (let yy = Math.max(0, fy - r); yy <= Math.min(h - 1, fy + r); yy++) {
          for (let xx = Math.max(0, fx - r); xx <= Math.min(w - 1, fx + r); xx++) {
            const p = prev[yy * w + xx];
            if (valid(p) && p < coldest) coldest = p;
          }
        }
        if (coldest < Infinity) feats.cooling[i] = (t - Math.min(coldest, topK)) * prevScale;
      }
      const sub = boxMean(x, y, cfg.size.subcoreBoxKm / 2 / km);
      feats.sub[i] = Number.isNaN(sub) ? 0 : sub - t;
      f.tK = t;
      f.ringDiffK = ring;
      f.sigmaK = feats.sigma[i];
      f.coolingK = feats.cooling[i];
      f.tailK = feats.tail[i];
      f.leadK = feats.lead[i];
      score[i] = convectiveScore(f, cfg);
    }
  }

  // the cells: pixels that score as rain (or carry lightning), grouped 8-connected
  const inCell = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (score[i] >= cfg.output.minScore) inCell[i] = 1;
    else if (lcore[i] + lenv[i] > 0 && valid(ir[i]) && ir[i] < topK) {
      f.tK = ir[i];
      f.lightningCore = lcore[i];
      f.lightningEnvelope = lenv[i];
      f.gradientKPerKm = feats.grad[i];
      if (shapedLightning(f, score[i], cfg) >= cfg.lightning.envelopeThreshold) inCell[i] = 1;
    }
  }
  // distance from the cell's edge (chamfer 3-4, in pixels x 3)
  const dist = new Uint16Array(n);
  for (let i = 0; i < n; i++) dist[i] = inCell[i] ? 65000 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!dist[i]) continue;
    let d = dist[i];
    if (x > 0) d = Math.min(d, dist[i - 1] + 3);
    else d = Math.min(d, 3);
    if (y > 0) {
      d = Math.min(d, dist[i - w] + 3);
      if (x > 0) d = Math.min(d, dist[i - w - 1] + 4);
      if (x < w - 1) d = Math.min(d, dist[i - w + 1] + 4);
    } else d = Math.min(d, 3);
    dist[i] = d;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!dist[i]) continue;
    let d = dist[i];
    if (x < w - 1) d = Math.min(d, dist[i + 1] + 3);
    if (y < h - 1) {
      d = Math.min(d, dist[i + w] + 3);
      if (x < w - 1) d = Math.min(d, dist[i + w + 1] + 4);
      if (x > 0) d = Math.min(d, dist[i + w - 1] + 4);
    }
    dist[i] = d;
  }
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  interface Cell { radiusKm: number; score: number; cx: number; cy: number; sigmaPx: number; maxDist: number; real: boolean; }
  const cells: Cell[] = [];
  const members: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!inCell[start] || label[start] >= 0) continue;
    const id = cells.length;
    let top = 0;
    stack[top++] = start;
    label[start] = id;
    members.length = 0;
    let area = 0, sw = 0, sx = 0, sy = 0, best = 0, maxDist = 0, coldest = Infinity, lit = false;
    while (top > 0) {
      const i = stack[--top];
      members.push(i);
      const x = i % w, y = (i - x) / w;
      area += rowKm[y] * rowKm[y];
      const wt = score[i] + 0.05 + lcore[i];
      sw += wt;
      sx += x * wt;
      sy += y * wt;
      best = Math.max(best, score[i]);
      maxDist = Math.max(maxDist, dist[i]);
      coldest = Math.min(coldest, ir[i]);
      if (lcore[i] > 0.05) lit = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (inCell[j] && label[j] < 0) {
          label[j] = id;
          stack[top++] = j;
        }
      }
    }
    let cx = sx / sw, cy = sy / sw;
    const yc = Math.min(h - 1, Math.max(0, Math.round(cy)));
    const km = rowKm[yc];
    const radiusKm = Math.sqrt(area / Math.PI);
    // the core toward where the low cloud goes (850 hPa)
    const [u8, v8] = windAt(Math.round(cx), yc);
    const ls = Math.hypot(u8, v8);
    if (ls > 1) {
      cx += (u8 / ls) * cfg.size.inflowShift * radiusKm / km;
      cy -= (v8 / ls) * cfg.size.inflowShift * radiusKm / km;
    }
    const sigmaPx = Math.max(1.5 / km, (cfg.size.coreFraction * radiusKm) / 1.55 / km);
    cells.push({ radiusKm, score: best, cx, cy, sigmaPx, maxDist, real: coldest <= cfg.cloud.coreMaxK || lit });
  }

  // the reflectivity
  const dbz = new Float32Array(n);
  let popups = 0, cores = 0;
  const popupCells = new Set<number>();
  for (let i = 0; i < n; i++) {
    const t = ir[i];
    if (!valid(t) || t >= topK) continue;
    if (lcore[i] + lenv[i] === 0 && label[i] < 0) continue;
    const x = i % w, y = (i - x) / w;
    const c = label[i] >= 0 && cells[label[i]].real ? cells[label[i]] : null;
    f.tK = t;
    f.ringDiffK = feats.ring[i];
    f.sigmaK = feats.sigma[i];
    f.coolingK = feats.cooling[i];
    f.tailK = feats.tail[i];
    f.leadK = feats.lead[i];
    f.cellRadiusKm = c ? c.radiusKm : 0;
    f.cellScore = c ? c.score : 0;
    f.coreProfile = c ? Math.exp(-((x - c.cx) ** 2 + (y - c.cy) ** 2) / (2 * c.sigmaPx * c.sigmaPx)) : 0;
    f.ridge = c && c.maxDist > 0 ? dist[i] / c.maxDist : 0;
    f.subcoreK = feats.sub[i];
    f.lightningCore = lcore[i];
    f.lightningEnvelope = lenv[i];
    f.gradientKPerKm = feats.grad[i];
    const r = classifyPixel(f, cfg);
    dbz[i] = r.dbz;
    if (r.category === 'lightning' && r.dbz >= cfg.lightning.core[0]) cores++;
    if (c && f.coolingK <= -cfg.popup.coolingK[0] && !popupCells.has(label[i])) {
      popupCells.add(label[i]);
      popups++;
    }
  }

  // rule 4: shift to match the real radar where both see rain
  let offsetDb = 0, pairs = 0;
  const rad = input.radar;
  if (rad && rad.discs.length) {
    const diffs: number[] = [];
    const rx0 = (rad.box.west + 180) / 360, rx1 = (rad.box.east + 180) / 360;
    const ry0 = mercY(rad.box.north), ry1 = mercY(rad.box.south);
    const discs = rad.discs.map(d => ({ x: (d.lng + 180) / 360, y: mercY(d.lat), r: d.rangeKm / EARTH_KM / Math.cos((d.lat * Math.PI) / 180) }));
    for (let y = 0; y < h; y++) {
      const my = y0m + (y + 0.5) * pxMerc;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (dbz[i] <= 0) continue;
        const mx = x0m + (x + 0.5) * pxMerc;
        if (!discs.some(d => Math.hypot(mx - d.x, my - d.y) < d.r)) continue;
        const u = Math.floor(((mx - rx0) / (rx1 - rx0)) * rad.width);
        const v = Math.floor(((my - ry0) / (ry1 - ry0)) * rad.height);
        if (u < 0 || v < 0 || u >= rad.width || v >= rad.height) continue;
        const b = rad.field[v * rad.width + u];
        if (!b) continue;
        diffs.push(12 + 9.6 * ((b * rad.maxIntensity) / 255) - dbz[i]);
      }
    }
    pairs = diffs.length;
    if (pairs >= cfg.blend.calibrationMinPairs) {
      diffs.sort((a, b) => a - b);
      const lim = cfg.blend.calibrationMaxDb;
      offsetDb = Math.max(-lim, Math.min(lim, diffs[pairs >> 1]));
    }
  }

  const dbz4 = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (dbz[i] <= 0) continue;
    const d = Math.min(cfg.output.maxDbz, dbz[i] + offsetDb);
    if (d >= cfg.output.minDbz) dbz4[i] = Math.min(255, Math.round(d * 4));
  }
  return {
    dbz4,
    stats: { cells: cells.filter(c => c.real).length, popups, lightningCores: cores, offsetDb, pairs, usedPrevious: !!prev, strikes: strikesUsed, ms: Math.round(performance.now() - started) },
  };
}
