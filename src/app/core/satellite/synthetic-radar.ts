/**
 * Synthetic radar: the rain a radar would see where no working radar does, read from our own Meteosat data pack (measured 10.8 um cloud-top
 * temperatures, about 3 km a pixel), the frame 15 minutes before it, ILDN lightning and the forecast 850 and 250 hPa winds, the way the owner
 * reads the satellite: rain falls under the cores only, not under the cloud.
 *
 * 1. A core is where a cloud blooms: a top colder than anything within 12 km of it a frame (15 minutes) before, where the low-level wind
 *    brought it from (at night the only sign: a dark core out of nowhere in the infrared; an anvil spreading out is never colder than the
 *    core it comes from, so it is none), or a patch cooling faster than everything 12 km around it (a tower; a spreading anvil cools along
 *    an arc, so it is none), or a dome standing out of the cloud (colder than the cloud 15 to 25 km around in all directions but
 *    two, and bubbly). Flat high cloud (an anvil, cirrus, its rim) is none however cold, and an anvil tail warming downwind along the 250 hPa
 *    shear from a colder core is worn away. Only the strongest point within about 8 km is a core.
 * 2. The rain stays where the core bloomed and goes with the 850 hPa wind, while the anvil above spreads away: blooms of the last hour of
 *    frames are carried to now with that wind and fade after 20 minutes (gone after an hour). A bloom rains over the patch that bloomed
 *    with it (the shape it bloomed in: a cell 10 km wide and 30 km long stays so), lighter at its edge and as heavy as the core where it
 *    cooled as much; each core is drawn as rain about 5 km wide, stretched toward where it goes (its next 15 minutes, 10 km at most):
 *    24 to 42 dBZ by how strongly it bloomed, a little more in very cold tops. A band is a row of such cores, never a filled cloud.
 * 3. Lightning (last 15 minutes, newer weighed more) adds rain only where strokes come two or more within about 2 km (25 to 38 dBZ), and a
 *    heavy core (47 to 58 dBZ, 5 km wide) where they crowd most, one within every 10 km; on cloud only.
 *    Rain reaching the ground spreads a little: a light rim (about 15 to 25 dBZ, 7 km at most) around it, under cloud only.
 * 4. Where Chennai or Karaikal see, the real radar is drawn (the layer fades the estimate out over the last 20 km of their range), and
 *    where both see rain the estimate is shifted by the median difference (a few dB at most) so it joins the radar without a step.
 *
 * The rain is drawn on a grid twice as fine as the data (about 1.5 km) so a 5 km core keeps its shape. Everything that can be tuned is in
 * SYNTHETIC_RADAR_CONFIG (live, from the browser console: atmosSyntheticRadar.set({...})).
 */

/** All thresholds. Temperatures in kelvin, distances in km, reflectivity in dBZ. */
export interface SyntheticRadarConfig {
  cloud: {
    /** Warmer than this is low cloud or ground (yellow in the infrared): never rain here (and the ring counts the ground as this warm). */
    topK: number;
    /** A core is colder than this (a low cloud popping up is white by then). */
    coreMaxK: number;
  };
  anvil: {
    /** The ring a dome is measured against. */
    ringInnerKm: number;
    ringOuterKm: number;
    /** Colder than the ring by less than this: flat (anvil, cirrus, stratiform); by ringDiffFullK or more: a full dome. */
    ringDiffMinK: number;
    ringDiffFullK: number;
    /** Spread of the temperatures over 5 x 5 pixels below which the cloud is smooth (cirrus), and above which it is fully bubbly. */
    textureMinK: number;
    textureFullK: number;
    /** How far upwind along the shear an anvil tail's core is looked for, and the warming that makes a tail (start, full). */
    upshearKm: number;
    tailWarmK: [number, number];
    /** How much of a tail is worn away (0 to 1). */
    erosion: number;
    /** How far ahead along the 850 hPa wind the leading edge is looked for, the warming there that makes it sharp, and its extra strength. */
    leadKm: number;
    leadEdgeK: [number, number];
    leadBoost: number;
  };
  popup: {
    /** Colder than 15 minutes before by this much (start, full): the cloud bloomed. */
    coolingK: [number, number];
    /** Nothing as cold this far around the place the 850 hPa wind brought it from, a frame before. */
    searchKm: number;
    /** A bloom is a top colder than this (a warm-rain popup from low cloud is caught by then). */
    bloomMaxK: number;
    /** Or a patch cooling more than the cloud isolationKm around it in every direction, by this much (start, full): a tower, where an
     * anvil spreading out cools along an arc. */
    isolationKm: number;
    isolationK: [number, number];
  };
  core: {
    /** A core needs at least this strength (0 to 1). */
    minStrength: number;
    /** Only the strongest core within this distance is drawn. */
    spacingKm: number;
    /** A dome's core is colder than its cloud within domeKm by standOutK, unless that cloud covers no more than smallCloudKm2. */
    domeKm: number;
    standOutK: number;
    smallCloudKm2: number;
    /** The rain's width across a core. */
    widthKm: number;
    /** It reaches as far as the 850 hPa wind takes it in this time, and no farther than maxTrailKm. */
    trailMinutes: number;
    maxTrailKm: number;
    /** Reflectivity at the core (weakest, strongest bloom), the extra for a top as cold as coldK, and at its edge. */
    dbz: [number, number];
    coldBonusDbz: number;
    coldK: number;
    edgeDbz: number;
    /** An older bloom keeps its strength this long, then loses fadeDbzPerMin a minute, and is gone at lifeMinutes. */
    holdMinutes: number;
    fadeDbzPerMin: number;
    lifeMinutes: number;
    /** A bloom rains over the patch that bloomed with it: around it, cooled by at least patchShare of the core's cooling, no farther than
     * patchMaxKm; patchEdgeDbz at the patch's edge, the core's reflectivity where it cooled as much as the core. */
    patchShare: number;
    patchMaxKm: number;
    patchEdgeDbz: number;
  };
  lightning: {
    /** Weight of a stroke: exp(-age / tauMin), none after maxAgeMin. */
    tauMin: number;
    maxAgeMin: number;
    /** How far around a stroke the rain is (Gaussian radius). */
    radiusKm: number;
    /** Density (about: fresh strokes within radiusKm) from which there is rain, and from which a heavy core (one within spacingKm). */
    rainThreshold: number;
    coreThreshold: number;
    spacingKm: number;
    rain: [number, number];
    core: [number, number];
  };
  spread: {
    /** Rain reaching the ground spreads a little beyond its cores: a rim at most maxDbz (and no more than the rain it comes from), losing
     * dbzPerKm a kilometre, under cloud colder than cloudMaxK only. */
    maxDbz: number;
    dbzPerKm: number;
    cloudMaxK: number;
  };
  output: {
    minDbz: number;
    maxDbz: number;
    /** The rain grid is this many times finer than the data. */
    scale: number;
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
  cloud: { topK: 278.3, coreMaxK: 250 },
  anvil: {
    ringInnerKm: 15,
    ringOuterKm: 25,
    ringDiffMinK: 5,
    ringDiffFullK: 15,
    textureMinK: 1.2,
    textureFullK: 4.5,
    upshearKm: 15,
    tailWarmK: [1.5, 6],
    erosion: 0.85,
    leadKm: 9,
    leadEdgeK: [2, 10],
    leadBoost: 0.2,
  },
  popup: { coolingK: [8, 18], searchKm: 12, bloomMaxK: 252, isolationKm: 12, isolationK: [8, 18] },
  core: {
    minStrength: 0.5,
    spacingKm: 8,
    domeKm: 12,
    standOutK: 2,
    smallCloudKm2: 300,
    widthKm: 5,
    trailMinutes: 15,
    maxTrailKm: 10,
    dbz: [24, 42],
    coldBonusDbz: 6,
    coldK: 210,
    edgeDbz: 18,
    holdMinutes: 20,
    fadeDbzPerMin: 0.4,
    lifeMinutes: 60,
    patchShare: 0.6,
    patchMaxKm: 12,
    patchEdgeDbz: 22,
  },
  lightning: {
    tauMin: 8,
    maxAgeMin: 15,
    radiusKm: 2,
    rainThreshold: 1,
    coreThreshold: 3,
    spacingKm: 10,
    rain: [25, 38],
    core: [47, 58],
  },
  spread: { maxDbz: 26, dbzPerKm: 1.5, cloudMaxK: 265 },
  output: { minDbz: 15, maxDbz: 60, scale: 2 },
  blend: { featherKm: 20, calibrationMaxDb: 8, calibrationMinPairs: 150 },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** A copy of the config with some values changed (each group merged). */
export function tuneConfig(base: SyntheticRadarConfig, patch: DeepPartial<SyntheticRadarConfig>): SyntheticRadarConfig {
  const out = structuredClone(base) as unknown as Record<string, Record<string, unknown>>;
  for (const [group, values] of Object.entries(patch ?? {})) {
    if (!(group in out) || !values) continue;
    Object.assign(out[group], values);
  }
  return out as unknown as SyntheticRadarConfig;
}

/** What is known at a pixel of the data: enough to say whether a core is there and how strong. */
export interface CoreFeatures {
  /** Cloud-top temperature (10.8 um). 0 or NaN: no data. */
  tK: number;
  /** How much colder than the ring 15 to 25 km around the pixel is, in all directions but two (the third least of eight). */
  ringDiffK: number;
  /** Spread of the temperatures over 5 x 5 pixels. */
  sigmaK: number;
  /** Colder now than anything near where the cloud was 15 minutes before (negative = it bloomed); NaN without that frame. */
  coolingK: number;
  /** tK minus the cloud upwind along the shear (positive: warmer than a core behind it, a tail). */
  tailK: number;
  /** The cloud ahead along the 850 hPa wind minus tK (positive: a sharp leading edge). */
  leadK: number;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = ([a, b]: readonly [number, number], t: number): number => a + (b - a) * Math.min(1, Math.max(0, t));

/** How strongly a core blooms at a pixel (0: no core), from rule 1. */
export function coreStrength(f: CoreFeatures, cfg: SyntheticRadarConfig = SYNTHETIC_RADAR_CONFIG): number {
  if (!(f.tK > 0) || f.tK > cfg.cloud.coreMaxK) return 0;
  const a = cfg.anvil;
  const dome = smooth(a.ringDiffMinK, a.ringDiffFullK, f.ringDiffK) * (0.25 + 0.75 * smooth(a.textureMinK, a.textureFullK, f.sigmaK));
  const bloom = Number.isFinite(f.coolingK) ? smooth(cfg.popup.coolingK[0], cfg.popup.coolingK[1], -f.coolingK) : 0;
  const tail = 1 - a.erosion * smooth(a.tailWarmK[0], a.tailWarmK[1], f.tailK) * (1 - Math.max(dome, bloom));
  const lead = 1 + a.leadBoost * smooth(a.leadEdgeK[0], a.leadEdgeK[1], f.leadK);
  return Math.min(1, Math.max(dome, bloom) * tail * lead);
}

/** The reflectivity at a core: by its strength, more in a very cold top. */
export function coreDbz(strength: number, tK: number, cfg: SyntheticRadarConfig = SYNTHETIC_RADAR_CONFIG): number {
  const c = cfg.core;
  return lerp(c.dbz, (strength - c.minStrength) / (1 - c.minStrength)) + c.coldBonusDbz * smooth(cfg.cloud.coreMaxK - 10, c.coldK, tK);
}

/** The reflectivity over a bloom's patch, where it cooled share (patchShare to 1) of what its core did. */
export function patchDbz(coreDbzValue: number, share: number, cfg: SyntheticRadarConfig = SYNTHETIC_RADAR_CONFIG): number {
  const c = cfg.core;
  const t = Math.min(1, Math.max(0, (share - c.patchShare) / (1 - c.patchShare)));
  return lerp([Math.min(c.patchEdgeDbz, coreDbzValue), coreDbzValue], t * t); // heavy only near the core's own cooling
}

/** The reflectivity of a lightning core of density l (at least coreThreshold). */
export function lightningCoreDbz(l: number, cfg: SyntheticRadarConfig = SYNTHETIC_RADAR_CONFIG): number {
  return lerp(cfg.lightning.core, (l - cfg.lightning.coreThreshold) / (2 * cfg.lightning.coreThreshold));
}

/** What a pixel of the rain grid needs to know: the nearest core's reflectivity and how far across and along it the pixel is. */
export interface RainPixel {
  /** On cloud (lightning rain is drawn on cloud only). */
  cloudy: boolean;
  /** The core's reflectivity (0: no core near), the distance from its line (km) and how far along it (0 where it bloomed, 1 at its end). */
  coreDbz: number;
  acrossKm: number;
  along: number;
  /** Lightning density (time-weighted strokes within about radiusKm). */
  lightning: number;
}

/** The radar reflectivity at a pixel of the rain grid (rules 2 and 3); 0: none. */
export function classifyPixel(p: RainPixel, cfg: SyntheticRadarConfig = SYNTHETIC_RADAR_CONFIG): number {
  let dbz = 0;
  const half = cfg.core.widthKm / 2;
  if (p.coreDbz > 0 && p.acrossKm < half) {
    const peak = p.coreDbz - 4 * p.along; // a little weaker toward where it goes
    const r = p.acrossKm / half;
    const edge = Math.max(cfg.core.edgeDbz, peak - 14);
    dbz = edge + (peak - edge) * (1 - r * r * r * r); // flat-topped: the core keeps its strength across most of its width
  }
  const l = cfg.lightning;
  if (p.cloudy && p.lightning >= l.rainThreshold) dbz = Math.max(dbz, lerp(l.rain, (p.lightning - l.rainThreshold) / (l.coreThreshold - l.rainThreshold)));
  return dbz < cfg.output.minDbz ? 0 : Math.min(cfg.output.maxDbz, dbz);
}

/** The radar's intensity for a reflectivity (as the radar layer draws it: v = (dBZ - 12) / 9.6). */
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
  /** Cloud-top temperatures (K, 0 = no data): 10.8 um now... */
  ir: Float32Array;
  /** ...and in the frames of the last hour before it (each with how many minutes older it is), for the blooms. */
  history?: { ir: Float32Array; minutesAgo: number }[];
  wind?: WindGrids | null;
  strikes?: readonly StrikeInput[];
  radar?: RealRadarInput | null;
}

/** A core drawn (for the stats and the tests): where it is now, how strong, what made it and how many minutes ago. */
export interface Core {
  lat: number;
  lon: number;
  dbz: number;
  kind: 'dome' | 'bloom' | 'lightning';
  ageMin: number;
}

export interface SyntheticRadarStats {
  cores: number;
  /** Cores from blooms (in the last hour). */
  popups: number;
  /** Lightning strokes over the grid, and the area of heavy rain (45 dBZ or more, km2). */
  strikes: number;
  heavyKm2: number;
  /** The shift applied to match the real radar (dB), and from how many pixels. */
  offsetDb: number;
  pairs: number;
  usedPrevious: boolean;
  ms: number;
}

export interface SyntheticRadarOutput {
  /** Reflectivity x 4 per pixel (0: none), row-major over the same box as the input, w x h pixels (scale times the data's). */
  dbz4: Uint8Array;
  w: number;
  h: number;
  cores: Core[];
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

/** The synthetic radar over the data pack's box (rules 1 to 4). */
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
  const rowLat = new Float32Array(h);
  const rowKm = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    rowLat[y] = latOfMercY(y0m + ((y + 0.5) / h) * (y1m - y0m));
    rowKm[y] = pxMerc * EARTH_KM * Math.cos((rowLat[y] * Math.PI) / 180);
  }
  const lonOf = (x: number): number => box.west + ((x + 0.5) / w) * (box.east - box.west);
  const valid = (v: number): boolean => v > 0;

  const sumT = summed(ir, w, h, v => (valid(v) ? Math.min(v, topK) : 0));
  // the texture counts cloud only (a cloud's edge against the ground is no bubbling)
  const cloud = (v: number): boolean => valid(v) && v < topK;
  const sumC = summed(ir, w, h, v => (cloud(v) ? 1 : 0));
  const sumTc = summed(ir, w, h, v => (cloud(v) ? v : 0));
  const sumT2c = summed(ir, w, h, v => (cloud(v) ? v * v : 0));
  const sumN = summed(ir, w, h, v => (valid(v) ? 1 : 0));
  const boxMean = (cx: number, cy: number, r: number): number => {
    const x0 = Math.round(cx - r), x1 = Math.round(cx + r), y0 = Math.round(cy - r), y1 = Math.round(cy + r);
    const c = boxSum(sumN, w, h, x0, y0, x1, y1);
    return c > 0 ? boxSum(sumT, w, h, x0, y0, x1, y1) / c : NaN;
  };
  // the cloud averaged over the ring's width, once: the ring is then read at 16 points
  const blur = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const r = Math.max(1, (cfg.anvil.ringOuterKm - cfg.anvil.ringInnerKm) / 4 / rowKm[y]);
    for (let x = 0; x < w; x++) blur[y * w + x] = valid(ir[y * w + x]) && ir[y * w + x] <= cfg.cloud.coreMaxK ? boxMean(x, y, r) : NaN;
  }
  const blurAt = (x: number, y: number): number => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return NaN;
    const b = blur[yi * w + xi];
    return Number.isNaN(b) ? boxMean(xi, yi, Math.max(1, (cfg.anvil.ringOuterKm - cfg.anvil.ringInnerKm) / 4 / rowKm[yi])) : b;
  };

  // winds (nearest forecast grid point), m/s east and north
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

  // a frame's coldest within radiusKm of each pixel (a min filter, rows then columns)
  const coldestAround = (frame: Float32Array, radiusKm = cfg.popup.searchKm): Float32Array => {
    const r = Math.max(1, Math.round(radiusKm / rowKm[h >> 1]));
    const a = new Float32Array(n), b = new Float32Array(n);
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
  };
  // how much a top cooled against the coldest near where the 850 hPa wind brought it from, or near the same place (the anvil spreads with
  // the upper wind, not the low one), per 15 minutes (NaN: no data there)
  const cooling = (t: number, x: number, y: number, coldest: Float32Array, minutes: number): number => {
    const [u8, v8] = windAt(x, y);
    const fx = Math.round(x - (u8 * minutes * 60) / 1000 / rowKm[y]);
    const fy = Math.round(y + (v8 * minutes * 60) / 1000 / rowKm[y]);
    if (fx < 0 || fy < 0 || fx >= w || fy >= h) return NaN;
    const c = Math.min(coldest[fy * w + fx], coldest[y * w + x]);
    return c === Infinity ? NaN : ((t - Math.min(c, topK)) * 15) / Math.max(5, minutes);
  };
  // the strongest within spacingKm (the colder on a tie)
  const pick = (strength: Float32Array, frame: Float32Array): number[] => {
    const out: number[] = [];
    for (let y = 0; y < h; y++) {
      const r = Math.max(1, Math.round(cfg.core.spacingKm / rowKm[y]));
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (strength[i] < cfg.core.minStrength) continue;
        const key = strength[i] + 0.002 * (topK - frame[i]);
        let best = true;
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r) && best; yy++) {
          for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
            const j = yy * w + xx;
            if (j === i || strength[j] < cfg.core.minStrength) continue;
            const k = strength[j] + 0.002 * (topK - frame[j]);
            if (k > key || (k === key && j < i)) {
              best = false;
              break;
            }
          }
        }
        if (best) out.push(i);
      }
    }
    return out;
  };

  // how much each top cooled since a frame before (per 15 minutes, against the place the 850 hPa wind brought it from or the same place,
  // whichever was colder; NaN: no data)
  const coolingField = (newer: Float32Array, older: Float32Array, minutes: number): Float32Array => {
    const cool = new Float32Array(n).fill(NaN);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const t = newer[i];
        if (!valid(t)) continue;
        const [u8, v8] = windAt(x, y);
        const fx = Math.round(x - (u8 * minutes * 60) / 1000 / rowKm[y]);
        const fy = Math.round(y + (v8 * minutes * 60) / 1000 / rowKm[y]);
        if (fx < 0 || fy < 0 || fx >= w || fy >= h) continue;
        const o = older[fy * w + fx], same = older[i];
        const before = valid(o) && valid(same) ? Math.min(o, same) : valid(o) ? o : same;
        if (valid(before)) cool[i] = ((Math.min(t, topK) - Math.min(before, topK)) * 15) / Math.max(5, minutes);
      }
    }
    return cool;
  };
  // a tower: a patch cooling more than the cloud isolationKm around it in every direction (0 to 1)
  const isolated = (cool: Float32Array, newer: Float32Array): Float32Array => {
    const out = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const r = cfg.popup.isolationKm / rowKm[y];
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const c = cool[i];
        if (!(c <= -cfg.popup.coolingK[0]) || newer[i] > cfg.popup.bloomMaxK) continue;
        let least = Infinity;
        for (const [dx, dy] of dirs) {
          const xx = Math.round(x + dx * r), yy = Math.round(y + dy * r);
          const v = xx >= 0 && yy >= 0 && xx < w && yy < h ? cool[yy * w + xx] : NaN;
          least = Math.min(least, Number.isNaN(v) ? 0 : v - c);
        }
        out[i] = smooth(cfg.popup.isolationK[0], cfg.popup.isolationK[1], least);
      }
    }
    return out;
  };
  const dirs = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)]);

  const history = (input.history ?? []).filter(fr => fr.ir.length === n && fr.minutesAgo > 0).sort((a, b) => a.minutesAgo - b.minutesAgo);
  const cores: { x: number; y: number; dbz: number; kind: Core['kind']; ageMin: number }[] = [];
  // a bloom's patch: the pixels around its core that cooled at least patchShare as much, within patchMaxKm, each with its share
  const patches: { at: number[]; share: number[]; dbz: number; dx: number; dy: number }[] = [];
  const grown = new Int32Array(n).fill(-1);
  const addPatch = (i0: number, cool: Float32Array, frame: Float32Array, dbz: number, dx: number, dy: number): void => {
    const c0 = cool[i0];
    if (!(c0 < 0)) return;
    const limit = -Math.max(cfg.popup.coolingK[0], cfg.core.patchShare * -c0);
    const x0 = i0 % w, y0 = Math.floor(i0 / w);
    const maxPx = cfg.core.patchMaxKm / rowKm[y0];
    const id = patches.length;
    const at: number[] = [i0], share: number[] = [1];
    grown[i0] = id;
    for (let q = 0; q < at.length; q++) {
      const i = at[q], x = i % w, y = Math.floor(i / w);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          const j = yy * w + xx;
          if (grown[j] === id || !(cool[j] <= limit) || frame[j] > cfg.popup.bloomMaxK || Math.hypot(xx - x0, yy - y0) > maxPx) continue;
          grown[j] = id;
          at.push(j);
          share.push(Math.min(1, cool[j] / c0));
        }
      }
    }
    patches.push({ at, share, dbz, dx, dy });
  };

  // rule 1, now: domes, and blooms since the newest frame before
  const strength = new Float32Array(n);
  const coldestPrev = history.length ? coldestAround(history[0].ir) : null;
  const side = new Float64Array(8);
  const coolNow = history.length ? coolingField(ir, history[0].ir, history[0].minutesAgo) : null;
  const towerNow = coolNow ? isolated(coolNow, ir) : null;
  const f: CoreFeatures = { tK: 0, ringDiffK: 0, sigmaK: 0, coolingK: NaN, tailK: 0, leadK: 0 };
  const bloomedNow = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const km = rowKm[y];
    const rIn = cfg.anvil.ringInnerKm / km;
    const rOut = cfg.anvil.ringOuterKm / km;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = ir[i];
      if (!valid(t) || t > Math.max(cfg.cloud.coreMaxK, cfg.popup.bloomMaxK)) continue;
      f.tK = t;
      f.coolingK = coldestPrev && t <= cfg.popup.bloomMaxK ? cooling(t, x, y, coldestPrev, history[0].minutesAgo) : NaN;
      if (t > cfg.cloud.coreMaxK) {
        // warmer than a dome can be: only a bloom
        const b = Math.max(Number.isFinite(f.coolingK) ? smooth(cfg.popup.coolingK[0], cfg.popup.coolingK[1], -f.coolingK) : 0, towerNow?.[i] ?? 0);
        strength[i] = b;
        if (b > 0) bloomedNow[i] = 1;
        continue;
      }
      // a dome: colder than the ring in all directions but two (a band is cold along its own line; the rim of a cold mass has three or
      // more cold directions, toward its middle)
      for (let k = 0; k < 8; k++) {
        const [dx, dy] = dirs[k];
        const a = blurAt(x + dx * rIn, y + dy * rIn);
        const b = blurAt(x + dx * rOut, y + dy * rOut);
        const m = Number.isNaN(a) ? b : Number.isNaN(b) ? a : (a + b) / 2;
        side[k] = Number.isNaN(m) ? 0 : m - t;
      }
      f.ringDiffK = thirdLeast(side);
      const c = boxSum(sumC, w, h, x - 2, y - 2, x + 2, y + 2);
      const m1 = boxSum(sumTc, w, h, x - 2, y - 2, x + 2, y + 2) / c;
      const m2 = boxSum(sumT2c, w, h, x - 2, y - 2, x + 2, y + 2) / c;
      f.sigmaK = c >= 15 ? Math.sqrt(Math.max(0, m2 - m1 * m1)) : cfg.anvil.textureFullK; // a small cloud (part of the 5 x 5) is a tower
      const [u8, v8, u2, v2] = windAt(x, y);
      // an anvil tail: warmer than the cloud upwind along the shear (250 minus 850 hPa; y runs south)
      const su = u2 - u8, sv = -(v2 - v8);
      const ss = Math.hypot(su, sv);
      f.tailK = 0;
      if (ss > 3) {
        const up = cfg.anvil.upshearKm / km;
        const behind = boxMean(x - (su / ss) * up, y - (sv / ss) * up, 1);
        if (!Number.isNaN(behind)) f.tailK = t - behind;
      }
      // the leading edge: warmer ahead along the 850 hPa wind
      const ls = Math.hypot(u8, v8);
      f.leadK = 0;
      if (ls > 1) {
        const ahead = cfg.anvil.leadKm / km;
        const a = boxMean(x + (u8 / ls) * ahead, y - (v8 / ls) * ahead, 1);
        if (!Number.isNaN(a)) f.leadK = a - t;
      }
      strength[i] = Math.max(coreStrength(f, cfg), towerNow?.[i] ?? 0);
      if (f.coolingK <= -cfg.popup.coolingK[0] || (towerNow?.[i] ?? 0) > 0) bloomedNow[i] = 1;
    }
  }
  // a dome's core stands out of its own cloud (the rest of a popup's cloud stands out of the ground too, but does not rain), unless the
  // whole cloud is small (a tower of a few pixels)
  for (let y = 0; y < h; y++) {
    const r = Math.round(cfg.core.domeKm / rowKm[y]);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!(strength[i] > 0) || bloomedNow[i]) continue;
      const c = boxSum(sumC, w, h, x - r, y - r, x + r, y + r);
      if (c * rowKm[y] * rowKm[y] <= cfg.core.smallCloudKm2) continue;
      if (boxSum(sumTc, w, h, x - r, y - r, x + r, y + r) / c - ir[i] < cfg.core.standOutK) strength[i] = 0;
    }
  }
  for (const i of pick(strength, ir)) {
    const d = coreDbz(strength[i], ir[i], cfg);
    cores.push({ x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5, dbz: d, kind: bloomedNow[i] ? 'bloom' : 'dome', ageMin: 0 });
    if (bloomedNow[i] && coolNow) addPatch(i, coolNow, ir, d, 0, 0);
  }

  // rule 2: the blooms of the older frames, carried to now with the 850 hPa wind
  for (let k = 0; k + 1 < history.length; k++) {
    const newer = history[k], older = history[k + 1];
    if (newer.minutesAgo > cfg.core.lifeMinutes) break;
    const coldest = coldestAround(older.ir);
    const gap = older.minutesAgo - newer.minutesAgo;
    const cool = coolingField(newer.ir, older.ir, gap);
    const s = isolated(cool, newer.ir);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const t = newer.ir[i];
        if (!valid(t) || t > cfg.popup.bloomMaxK) continue;
        const c = cooling(t, x, y, coldest, gap);
        if (Number.isFinite(c)) s[i] = Math.max(s[i], smooth(cfg.popup.coolingK[0], cfg.popup.coolingK[1], -c));
      }
    }
    const age = newer.minutesAgo;
    const fade = cfg.core.fadeDbzPerMin * Math.max(0, age - cfg.core.holdMinutes);
    for (const i of pick(s, newer.ir)) {
      const x = i % w, y = Math.floor(i / w);
      const [u8, v8] = windAt(x, y);
      const d = coreDbz(s[i], newer.ir[i], cfg) - fade;
      if (d < cfg.output.minDbz + 3) continue;
      const dx = (u8 * age * 60) / 1000 / rowKm[y], dy = -(v8 * age * 60) / 1000 / rowKm[y];
      cores.push({ x: x + 0.5 + dx, y: y + 0.5 + dy, dbz: d, kind: 'bloom', ageMin: age });
      addPatch(i, cool, newer.ir, d, dx, dy);
    }
  }

  // rule 3: lightning density on the rain grid (scale times finer than the data)
  const S = Math.max(1, Math.round(cfg.output.scale));
  const W2 = w * S, H2 = h * S, n2 = W2 * H2;
  const cloudyAt = (x2: number, y2: number): boolean => {
    const t = ir[Math.min(h - 1, Math.floor(y2 / S)) * w + Math.min(w - 1, Math.floor(x2 / S))];
    return valid(t) && t < topK;
  };
  const lden = new Float32Array(n2);
  let strikes = 0;
  for (const st of input.strikes ?? []) {
    const age = st.ageS / 60;
    if (age < 0 || age > cfg.lightning.maxAgeMin) continue;
    const sx = (((st.lon + 180) / 360 - x0m) / pxMerc) * S;
    const sy = ((mercY(st.lat) - y0m) / pxMerc) * S;
    if (sx < 0 || sy < 0 || sx >= W2 || sy >= H2) continue;
    strikes++;
    const km = rowKm[Math.min(h - 1, Math.floor(sy / S))] / S;
    const sg = cfg.lightning.radiusKm / km;
    const wt = Math.exp(-age / cfg.lightning.tauMin);
    const r = Math.ceil(sg * 3);
    for (let y = Math.max(0, Math.floor(sy - r)); y <= Math.min(H2 - 1, Math.ceil(sy + r)); y++) {
      for (let x = Math.max(0, Math.floor(sx - r)); x <= Math.min(W2 - 1, Math.ceil(sx + r)); x++) {
        const d2 = (x + 0.5 - sx) ** 2 + (y + 0.5 - sy) ** 2;
        lden[y * W2 + x] += wt * Math.exp(-d2 / (2 * sg * sg));
      }
    }
  }
  // its heavy cores: the densest within spacingKm
  if (strikes > 0) {
    for (let y = 0; y < H2; y++) {
      const r = Math.max(1, Math.round(cfg.lightning.spacingKm / (rowKm[Math.floor(y / S)] / S)));
      for (let x = 0; x < W2; x++) {
        const i = y * W2 + x;
        const l = lden[i];
        if (l < cfg.lightning.coreThreshold || !cloudyAt(x, y)) continue;
        let best = true;
        for (let yy = Math.max(0, y - r); yy <= Math.min(H2 - 1, y + r) && best; yy++) {
          for (let xx = Math.max(0, x - r); xx <= Math.min(W2 - 1, x + r); xx++) {
            const j = yy * W2 + xx;
            if (lden[j] > l || (lden[j] === l && j < i)) {
              best = false;
              break;
            }
          }
        }
        if (best) cores.push({ x: (x + 0.5) / S, y: (y + 0.5) / S, dbz: lightningCoreDbz(l, cfg), kind: 'lightning', ageMin: 0 });
      }
    }
  }

  // the cores on the rain grid: 5 km wide, stretched toward where the 850 hPa wind takes them
  const dbz = new Float32Array(n2);
  const rain: RainPixel = { cloudy: true, coreDbz: 0, acrossKm: 0, along: 0, lightning: 0 };
  for (const c of cores) {
    const yRow = Math.min(h - 1, Math.max(0, Math.floor(c.y)));
    const [u8, v8] = windAt(Math.min(w - 1, Math.max(0, Math.floor(c.x))), yRow);
    let tx = (u8 * cfg.core.trailMinutes * 60) / 1000;
    let ty = -(v8 * cfg.core.trailMinutes * 60) / 1000;
    const len = Math.hypot(tx, ty);
    if (len > cfg.core.maxTrailKm) {
      tx *= cfg.core.maxTrailKm / len;
      ty *= cfg.core.maxTrailKm / len;
    }
    const km = rowKm[yRow] / S;
    const ax = c.x * S, ay = c.y * S, bx = ax + tx / km, by = ay + ty / km;
    const half = cfg.core.widthKm / 2 / km;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - half)), x1 = Math.min(W2 - 1, Math.ceil(Math.max(ax, bx) + half));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - half)), y1 = Math.min(H2 - 1, Math.ceil(Math.max(ay, by) + half));
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const qx = x + 0.5 - ax, qy = y + 0.5 - ay;
        const t = l2 > 0 ? Math.min(1, Math.max(0, (qx * dx + qy * dy) / l2)) : 0;
        rain.coreDbz = c.dbz;
        rain.acrossKm = Math.hypot(qx - t * dx, qy - t * dy) * km;
        rain.along = t;
        const v = classifyPixel(rain, cfg);
        const i = y * W2 + x;
        if (v > dbz[i]) dbz[i] = v;
      }
    }
  }
  // the blooms' patches, carried with the wind: each of the data's pixels spread as a soft tent 1.2 pixels wide and averaged, so the
  // patch has a smooth outline (where the tents cover it at least a third) and not the data's squares
  if (patches.length) {
    const num = new Float32Array(n2), den = new Float32Array(n2);
    const R = 1.2 * S;
    for (const p of patches) {
      for (let k = 0; k < p.at.length; k++) {
        const v = patchDbz(p.dbz, p.share[k], cfg);
        const cx = ((p.at[k] % w) + 0.5 + p.dx) * S, cy = (Math.floor(p.at[k] / w) + 0.5 + p.dy) * S;
        for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(H2 - 1, Math.ceil(cy + R)); y++) {
          for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(W2 - 1, Math.ceil(cx + R)); x++) {
            const t = 1 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / R;
            if (t <= 0) continue;
            num[y * W2 + x] += v * t;
            den[y * W2 + x] += t;
          }
        }
      }
    }
    for (let i = 0; i < n2; i++) {
      if (den[i] < 0.35) continue;
      const v = num[i] / den[i];
      if (v >= cfg.output.minDbz && v > dbz[i]) dbz[i] = v;
    }
  }
  // the rain right around the strokes
  if (strikes > 0) {
    rain.coreDbz = 0;
    for (let y = 0; y < H2; y++) {
      for (let x = 0; x < W2; x++) {
        const i = y * W2 + x;
        if (lden[i] < cfg.lightning.rainThreshold) continue;
        rain.cloudy = cloudyAt(x, y);
        rain.lightning = lden[i];
        const v = classifyPixel(rain, cfg);
        if (v > dbz[i]) dbz[i] = v;
      }
    }
  }

  // the spread on the ground: a light rim around the rain, fading outward (two chamfer passes carry the strongest rim value)
  {
    const rim = new Float32Array(n2).fill(-Infinity);
    for (let i = 0; i < n2; i++) if (dbz[i] > 0) rim[i] = Math.min(cfg.spread.maxDbz, dbz[i]);
    const step = (y: number): number => (cfg.spread.dbzPerKm * rowKm[Math.min(h - 1, Math.floor(y / S))]) / S;
    for (let y = 0; y < H2; y++) {
      const a = step(y), d = a * Math.SQRT2;
      for (let x = 0; x < W2; x++) {
        const i = y * W2 + x;
        let v = rim[i];
        if (x > 0) v = Math.max(v, rim[i - 1] - a);
        if (y > 0) {
          v = Math.max(v, rim[i - W2] - a);
          if (x > 0) v = Math.max(v, rim[i - W2 - 1] - d);
          if (x < W2 - 1) v = Math.max(v, rim[i - W2 + 1] - d);
        }
        rim[i] = v;
      }
    }
    for (let y = H2 - 1; y >= 0; y--) {
      const a = step(y), d = a * Math.SQRT2;
      for (let x = W2 - 1; x >= 0; x--) {
        const i = y * W2 + x;
        let v = rim[i];
        if (x < W2 - 1) v = Math.max(v, rim[i + 1] - a);
        if (y < H2 - 1) {
          v = Math.max(v, rim[i + W2] - a);
          if (x < W2 - 1) v = Math.max(v, rim[i + W2 + 1] - d);
          if (x > 0) v = Math.max(v, rim[i + W2 - 1] - d);
        }
        rim[i] = v;
      }
    }
    for (let y = 0; y < H2; y++) {
      for (let x = 0; x < W2; x++) {
        const i = y * W2 + x;
        if (dbz[i] > 0 || rim[i] < cfg.output.minDbz) continue;
        const t = ir[Math.min(h - 1, Math.floor(y / S)) * w + Math.min(w - 1, Math.floor(x / S))];
        if (valid(t) && t < cfg.spread.cloudMaxK) dbz[i] = rim[i];
      }
    }
  }

  // rule 4: shift to match the real radar where both see rain
  let offsetDb = 0, pairs = 0;
  const rad = input.radar;
  const pxMerc2 = pxMerc / S;
  if (rad && rad.discs.length) {
    const diffs: number[] = [];
    const rx0 = (rad.box.west + 180) / 360, rx1 = (rad.box.east + 180) / 360;
    const ry0 = mercY(rad.box.north), ry1 = mercY(rad.box.south);
    const discs = rad.discs.map(d => ({ x: (d.lng + 180) / 360, y: mercY(d.lat), r: d.rangeKm / EARTH_KM / Math.cos((d.lat * Math.PI) / 180) }));
    for (let y = 0; y < H2; y++) {
      const my = y0m + (y + 0.5) * pxMerc2;
      for (let x = 0; x < W2; x++) {
        const i = y * W2 + x;
        if (dbz[i] <= 0) continue;
        const mx = x0m + (x + 0.5) * pxMerc2;
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

  const dbz4 = new Uint8Array(n2);
  let heavy = 0;
  for (let i = 0; i < n2; i++) {
    if (dbz[i] <= 0) continue;
    const d = Math.min(cfg.output.maxDbz, dbz[i] + offsetDb);
    if (d < cfg.output.minDbz) continue;
    dbz4[i] = Math.min(255, Math.round(d * 4));
    if (d >= 45) heavy += (rowKm[Math.floor(Math.floor(i / W2) / S)] / S) ** 2;
  }
  return {
    dbz4,
    w: W2,
    h: H2,
    cores: cores.map(c => ({ lat: latOfMercY(y0m + c.y * pxMerc), lon: box.west + (c.x / w) * (box.east - box.west), dbz: c.dbz, kind: c.kind, ageMin: c.ageMin })),
    stats: {
      cores: cores.length,
      popups: cores.filter(c => c.kind === 'bloom').length,
      strikes,
      heavyKm2: Math.round(heavy),
      offsetDb,
      pairs,
      usedPrevious: history.length > 0,
      ms: Math.round(performance.now() - started),
    },
  };
}
