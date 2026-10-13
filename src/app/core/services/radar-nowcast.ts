import { MotionBox, MotionField, motionAtPoint, motionFieldFromVectors } from './radar-motion';
import { MAX_STORM_SPEED_KMH, TrackingGrid, estimateMotion } from './storm-tracking';

/**
 * Looking ahead on the radar: the picture slid along the motion of the rain (a "nowcast"), when rain will reach a place, and a check of how well
 * that guess did on the last hour. All pure, so it can be tested.
 *
 * It is extrapolation, not a forecast model: the rain keeps moving the way it moved over the last half hour. It cannot know about a shower that
 * has not started or one that is about to die, so the picture gets softer the further ahead it looks, and the app shows what it scored.
 */

/** A field on a box of latitude and longitude: rows evenly spaced in latitude (row 0 at the north edge), columns in longitude, the first and last on the edges. */
export interface FieldBox {
  west: number;
  north: number;
  east: number;
  south: number;
  width: number;
  height: number;
}

/** How far ahead the picture is slid, in minutes (the loop's own step is ten). */
export const NOWCAST_LEADS_MIN: readonly number[] = [10, 20, 30, 40, 50, 60];

/** The tracking grid (about 4 km cells) as a field box: cell (i, j) is centred on longitude west + (i + 0.5) * step. */
export function trackBox(grid: TrackingGrid): FieldBox {
  const west = grid.west + grid.step / 2;
  const north = grid.north - grid.step / 2;
  return { west, north, east: west + (grid.nx - 1) * grid.step, south: north - (grid.ny - 1) * grid.step, width: grid.nx, height: grid.ny };
}

/** The motion field between two pictures of the tracking grid `minutes` apart. Null when no rain could be followed. */
export function motionBetween(prev: Float32Array, curr: Float32Array, grid: TrackingGrid, minutes: number, box: MotionBox): MotionField | null {
  const maxShift = Math.ceil((MAX_STORM_SPEED_KMH * minutes) / 60 / (grid.step * 111.2));
  return motionFieldFromVectors(estimateMotion(prev, curr, grid.nx, grid.ny, maxShift), grid, minutes, box);
}

/**
 * The picture `minutes` ahead: each pixel takes the value from where the rain that will be there now is, found by stepping back along the
 * motion (a half step first, to follow a curving flow). Pixels that would come from outside the picture are empty. `outScale` makes the result
 * that many times coarser (2: half the width and height). The displacement is worked out every 8 pixels and interpolated between.
 */
export function advectField(src: ArrayLike<number>, box: FieldBox, motion: MotionField, minutes: number, outScale = 1): { field: Float32Array; width: number; height: number } {
  const outW = Math.max(2, Math.round(box.width / outScale));
  const outH = Math.max(2, Math.round(box.height / outScale));
  const out = new Float32Array(outW * outH);
  const hours = minutes / 60;
  const lonSpan = box.east - box.west;
  const latSpan = box.north - box.south;
  const B = 8;
  const gx = Math.ceil((outW - 1) / B) + 1;
  const gy = Math.ceil((outH - 1) / B) + 1;
  const dLon = new Float32Array(gx * gy);
  const dLat = new Float32Array(gx * gy);
  const m = { u: 0, v: 0 };
  for (let j = 0; j < gy; j++) {
    const lat = box.north - (Math.min(j * B, outH - 1) / (outH - 1)) * latSpan;
    for (let i = 0; i < gx; i++) {
      const lon = box.west + (Math.min(i * B, outW - 1) / (outW - 1)) * lonSpan;
      motionAtPoint(motion, lat, lon, m);
      motionAtPoint(motion, lat - (m.v * hours) / 2, lon - (m.u * hours) / 2, m);
      dLon[j * gx + i] = m.u * hours;
      dLat[j * gx + i] = m.v * hours;
    }
  }
  const sw = box.width;
  const sh = box.height;
  for (let oy = 0; oy < outH; oy++) {
    const lat = box.north - (oy / (outH - 1)) * latSpan;
    const j0 = Math.min(Math.floor(oy / B), gy - 2);
    const y0 = j0 * B;
    const y1 = Math.min((j0 + 1) * B, outH - 1);
    const ty = y1 > y0 ? (oy - y0) / (y1 - y0) : 0;
    for (let ox = 0; ox < outW; ox++) {
      const i0 = Math.min(Math.floor(ox / B), gx - 2);
      const x0 = i0 * B;
      const x1 = Math.min((i0 + 1) * B, outW - 1);
      const tx = x1 > x0 ? (ox - x0) / (x1 - x0) : 0;
      const a = j0 * gx + i0;
      const dlon = (dLon[a] * (1 - tx) + dLon[a + 1] * tx) * (1 - ty) + (dLon[a + gx] * (1 - tx) + dLon[a + gx + 1] * tx) * ty;
      const dlat = (dLat[a] * (1 - tx) + dLat[a + 1] * tx) * (1 - ty) + (dLat[a + gx] * (1 - tx) + dLat[a + gx + 1] * tx) * ty;
      const lon = box.west + (ox / (outW - 1)) * lonSpan;
      const sx = ((lon - dlon - box.west) / lonSpan) * (sw - 1);
      const sy = ((box.north - (lat - dlat)) / latSpan) * (sh - 1);
      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) continue;
      const ix = Math.min(Math.floor(sx), sw - 2);
      const iy = Math.min(Math.floor(sy), sh - 2);
      const fx = sx - ix;
      const fy = sy - iy;
      const p = iy * sw + ix;
      out[oy * outW + ox] = (src[p] * (1 - fx) + src[p + 1] * fx) * (1 - fy) + (src[p + sw] * (1 - fx) + src[p + sw + 1] * fx) * fy;
    }
  }
  return { field: out, width: outW, height: outH };
}

/** Box sizes whose three passes together approximate a Gaussian of the given sigma (the usual "boxes for Gauss" widths). */
function boxSizes(sigma: number, n = 3): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower--;
  const upper = lower + 2;
  const m = Math.round((12 * sigma * sigma - n * lower * lower - 4 * n * lower - 3 * n) / (-4 * lower - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? lower : upper));
}

/** One running-mean pass of half-width `r` along a line of `n` samples (`stride` apart from `offset`), the edge sample repeated beyond the ends. */
function boxLine(src: Float32Array, dst: Float32Array, n: number, stride: number, offset: number, r: number): void {
  let acc = (r + 1) * src[offset];
  for (let k = 1; k <= r; k++) acc += src[offset + Math.min(k, n - 1) * stride];
  const inv = 1 / (2 * r + 1);
  for (let i = 0; i < n; i++) {
    dst[offset + i * stride] = acc * inv;
    acc += src[offset + Math.min(i + r + 1, n - 1) * stride] - src[offset + Math.max(i - r, 0) * stride];
  }
}

/** A Gaussian blur (three box passes each way) of a `w` x `h` field, as a new array. */
export function gaussianBlurRect(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.6) return new Float32Array(src);
  const a = new Float32Array(src);
  const b = new Float32Array(src.length);
  for (const size of boxSizes(sigma)) {
    const r = (size - 1) >> 1;
    if (r < 1) continue;
    for (let y = 0; y < h; y++) boxLine(a, b, w, 1, y * w, r);
    for (let x = 0; x < w; x++) boxLine(b, a, h, w, x, r);
  }
  return a;
}

/** How soft the nowcast is `minutes` ahead (km): the further ahead, the less is known about where each shower will be. */
export function nowcastSigmaKm(minutes: number): number {
  return 1 + 0.04 * minutes;
}

/**
 * The radar picture (one byte per pixel, the radar's intensity scale) slid `minutes` ahead along the motion and softened, as bytes at 1 / `outScale`
 * of its size. `box` is the picture's own box.
 */
export function nowcastPicture(bytes: Uint8Array, box: FieldBox, motion: MotionField, minutes: number, outScale = 2): { field: Uint8Array; width: number; height: number } {
  const { field, width, height } = advectField(bytes, box, motion, minutes, outScale);
  const midLat = (box.north + box.south) / 2;
  const kmPerPx = ((box.east - box.west) * 111.32 * Math.cos((midLat * Math.PI) / 180)) / (width - 1);
  const soft = gaussianBlurRect(field, width, height, nowcastSigmaKm(minutes) / kmPerPx);
  const out = new Uint8Array(soft.length);
  for (let i = 0; i < out.length; i++) out[i] = soft[i] <= 0.5 ? 0 : soft[i] >= 255 ? 255 : Math.round(soft[i]);
  return { field: out, width, height };
}

// ── How well it did ──

/** Rain at a place: 1.0 on the radar's scale (21.6 dBZ), the colour where light rain begins. */
export const RAIN_INTENSITY = 1.0;
export const MODERATE_INTENSITY = 2.0;
export const HEAVY_INTENSITY = 3.0;

export interface RainScore {
  hits: number;
  misses: number;
  falseAlarms: number;
}

/** Where a picture had rain against where there was: hits (both), misses (only the real one) and false alarms (only the guess). */
export function scoreRain(guess: ArrayLike<number>, real: ArrayLike<number>, threshold = RAIN_INTENSITY): RainScore {
  let hits = 0;
  let misses = 0;
  let falseAlarms = 0;
  for (let i = 0; i < real.length; i++) {
    const g = guess[i] >= threshold;
    const r = real[i] >= threshold;
    if (g && r) hits++;
    else if (r) misses++;
    else if (g) falseAlarms++;
  }
  return { hits, misses, falseAlarms };
}

/** The share of the rain area that was matched: hits over everything that was either guessed or real (null when there was no rain at all). */
export function overlapShare(s: RainScore): number | null {
  const all = s.hits + s.misses + s.falseAlarms;
  return all === 0 ? null : s.hits / all;
}

export interface NowcastSkill {
  /** How far ahead the check looked, minutes. */
  leadMin: number;
  /** How many pictures it was tried on. */
  cases: number;
  /** The share of the rain area the nowcast matched, and the share a picture that did not move would have matched. */
  nowcast: number;
  still: number;
}

/** A radar picture on the tracking grid, with its time. */
export interface TrackFrame {
  timeMs: number;
  track: Float32Array;
}

/**
 * Tries the nowcast on the pictures there are: for each, a guess `leadMin` ahead made from the picture that long before it and the motion between
 * that and a picture 15 to 40 minutes earlier, against what the radar then showed. Null when there are too few pictures, or too little rain, to say.
 */
export function verifyNowcast(frames: readonly TrackFrame[], grid: TrackingGrid, box: MotionBox, leadMin = 30, maxCases = 3): NowcastSkill | null {
  const sorted = [...frames].sort((a, b) => a.timeMs - b.timeMs);
  const minute = 60_000;
  const near = (target: number, tolerance: number, until: number): TrackFrame | undefined =>
    sorted.slice(0, until).reduce<TrackFrame | undefined>((best, f) => (Math.abs(f.timeMs - target) <= tolerance && (!best || Math.abs(f.timeMs - target) < Math.abs(best.timeMs - target)) ? f : best), undefined);
  const total: RainScore = { hits: 0, misses: 0, falseAlarms: 0 };
  const still: RainScore = { hits: 0, misses: 0, falseAlarms: 0 };
  let cases = 0;
  const fieldBox = trackBox(grid);
  for (let t = sorted.length - 1; t >= 1 && cases < maxCases; t--) {
    const target = sorted[t];
    const source = near(target.timeMs - leadMin * minute, 6 * minute, t);
    if (!source) continue;
    const sourceIndex = sorted.indexOf(source);
    const earlier = sorted
      .slice(0, sourceIndex)
      .filter(f => source.timeMs - f.timeMs >= 15 * minute && source.timeMs - f.timeMs <= 40 * minute)
      .sort((a, b) => Math.abs(source.timeMs - a.timeMs - 30 * minute) - Math.abs(source.timeMs - b.timeMs - 30 * minute))[0];
    if (!earlier) continue;
    const motion = motionBetween(earlier.track, source.track, grid, (source.timeMs - earlier.timeMs) / minute, box);
    if (!motion) continue;
    const guess = advectField(source.track, fieldBox, motion, (target.timeMs - source.timeMs) / minute, 1).field;
    const a = scoreRain(guess, target.track);
    const b = scoreRain(source.track, target.track);
    total.hits += a.hits; total.misses += a.misses; total.falseAlarms += a.falseAlarms;
    still.hits += b.hits; still.misses += b.misses; still.falseAlarms += b.falseAlarms;
    cases++;
  }
  const nowcast = overlapShare(total);
  const stillShare = overlapShare(still);
  if (cases === 0 || nowcast === null || stillShare === null || total.hits + total.misses < 120) return null;   // under about 2000 km2 of rain: nothing to judge by
  return { leadMin, cases, nowcast, still: stillShare };
}

// ── Rain at a place ──

export interface RainEta {
  /**
   * `dry`: none within the horizon; `approaching`: rain will reach the place in `minutes`; `raining`: it is raining there and goes on past the horizon
   * (`minutes` null); `clearing`: it is raining and will stop in `minutes`.
   */
  status: 'dry' | 'approaching' | 'raining' | 'clearing';
  minutes: number | null;
  /** The strongest echo that will pass over the place in that time (the radar's scale), for the words "light", "moderate" and "heavy". */
  peak: number;
}

/** "light", "moderate" or "heavy", from the radar's intensity. */
export function strengthWord(peak: number): 'light' | 'moderate' | 'heavy' {
  return peak >= HEAVY_INTENSITY ? 'heavy' : peak >= MODERATE_INTENSITY ? 'moderate' : 'light';
}

/**
 * When rain reaches a place, or stops there, from the radar picture and the motion of the rain. The place is followed back along the motion,
 * five minutes at a time, and the picture is read where the rain that will be there then is now; the strongest echo within a circle that grows
 * with the time ahead (the further ahead, the less sure where it goes) counts. `sample(lat, lon)` gives the picture's intensity.
 */
export function rainEta(sample: (lat: number, lon: number) => number, motion: MotionField, lat: number, lon: number, horizonMin = 90, stepMin = 5): RainEta {
  const steps = Math.floor(horizonMin / stepMin);
  const values: number[] = [];
  const m = { u: 0, v: 0 };
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let la = lat;
  let lo = lon;
  for (let k = 0; k <= steps; k++) {
    const radiusKm = 2.5 + 0.08 * k * stepMin;
    const dLat = radiusKm / 111.32;
    const dLon = radiusKm / (111.32 * cosLat);
    let v = sample(la, lo);
    for (let a = 0; a < 8; a++) {
      const ang = (a * Math.PI) / 4;
      v = Math.max(v, sample(la + dLat * Math.cos(ang), lo + dLon * Math.sin(ang)));
    }
    values.push(v);
    motionAtPoint(motion, la, lo, m);
    la -= (m.v * stepMin) / 60;
    lo -= (m.u * stepMin) / 60;
  }
  const wet = (v: number) => v >= RAIN_INTENSITY;
  if (wet(values[0])) {
    for (let k = 1; k < values.length; k++) {
      if (!wet(values[k]) && (k === values.length - 1 || !wet(values[k + 1]))) {
        return { status: 'clearing', minutes: k * stepMin, peak: Math.max(...values.slice(0, k)) };
      }
    }
    return { status: 'raining', minutes: null, peak: Math.max(...values) };
  }
  for (let k = 1; k < values.length; k++) {
    if (wet(values[k])) return { status: 'approaching', minutes: k * stepMin, peak: Math.max(...values.slice(k, k + 4)) };
  }
  return { status: 'dry', minutes: null, peak: 0 };
}

/**
 * Reads a radar picture (one byte per pixel on the 0 to 6 intensity scale, rows evenly spaced in latitude from the north edge, columns in longitude;
 * `coordinates` are the corners [lng, lat] NW, NE, SE, SW) at a place, bilinearly. Outside the picture there is no echo.
 */
export function makeSampler(
  field: Uint8Array,
  width: number,
  height: number,
  coordinates: readonly [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]],
): (lat: number, lon: number) => number {
  const west = coordinates[0][0];
  const east = coordinates[1][0];
  const north = coordinates[0][1];
  const south = coordinates[2][1];
  return (lat, lon) => {
    const x = ((lon - west) / (east - west)) * (width - 1);
    const y = ((north - lat) / (north - south)) * (height - 1);
    if (!(x >= 0 && y >= 0 && x <= width - 1 && y <= height - 1)) return 0;
    const x0 = Math.min(Math.floor(x), width - 2);
    const y0 = Math.min(Math.floor(y), height - 2);
    const fx = x - x0;
    const fy = y - y0;
    const p = y0 * width + x0;
    const byte = (field[p] * (1 - fx) + field[p + 1] * fx) * (1 - fy) + (field[p + width] * (1 - fx) + field[p + width + 1] * fx) * fy;
    return (byte * 6) / 255;
  };
}

/** "a few minutes" or "25 min": a time to the nearest five minutes, for words (the guess is no better than that). */
export function aboutMinutes(minutes: number): string {
  return minutes <= 7 ? 'a few minutes' : `${Math.round(minutes / 5) * 5} min`;
}

/** The words for a place's rain: a line, and whether it is wet now or soon (for the colour). */
export function describeRainEta(eta: RainEta, horizonMin = 90): { text: string; wet: boolean } {
  const strength = strengthWord(eta.peak);
  switch (eta.status) {
    case 'approaching':
      return { text: `Rain in ${aboutMinutes(eta.minutes ?? 0)} · ${strength}`, wet: true };
    case 'clearing':
      return { text: `Raining now (${strength}) · easing in ${aboutMinutes(eta.minutes ?? 0)}`, wet: true };
    case 'raining':
      return { text: `Raining now (${strength}) · no break in the next ${horizonMin} min`, wet: true };
    default:
      return { text: `No rain on the radar in the next ${horizonMin} min`, wet: false };
  }
}
