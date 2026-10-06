/**
 * Reading the scan time printed on an IMD radar picture.
 *
 * Some stations' pictures (Mangaluru, Sriharikota) carry no timestamp in the GIF itself, and the server's own "last modified"
 * time only says when the file was copied, not when the radar scanned: a picture that is hours old looks new. The scan time is
 * printed in the picture's side panel as "HH:MM:SS UTC / DD Mon YYYY", in a bold font. This reads those six digits by matching
 * each one against pre-rendered digit shapes (radar-stamp-templates.ts). The date is not read: it is the latest day on which
 * that time is not after the moment the file was served (see `stampEpoch`).
 */
import { STAMP_COLS, STAMP_FONTS, STAMP_ROWS } from './radar-stamp-templates';

export interface StampBox { x: number; y: number; w: number; h: number }

export interface StampTime { hours: number; minutes: number; seconds: number }

/** Largest mean difference per digit cell that still counts as a read digit (the best fits on real pictures are about 0.15). */
const MAX_CELL_ERROR = 0.3;
const INK_BELOW = 140;     // grey level under which a pixel is text

/** n bins over [start, start + length), as weights over `count` source cells: each row is the average over its bin. */
function binWeights(start: number, length: number, n: number, count: number): Float32Array[] {
  const step = length / n;
  const rows: Float32Array[] = [];
  for (let j = 0; j < n; j++) {
    const row = new Float32Array(count);
    const a = start + j * step;
    const b = a + step;
    for (let c = Math.max(0, Math.floor(a)); c < Math.min(count, Math.ceil(b)); c++) {
      row[c] = Math.max(0, Math.min(b, c + 1) - Math.max(a, c)) / step;
    }
    rows.push(row);
  }
  return rows;
}

const templateCache = new Map<string, Float32Array>();
function template(font: string, digit: string): Float32Array {
  const key = font + digit;
  let t = templateCache.get(key);
  if (!t) {
    t = Float32Array.from(STAMP_FONTS[font].digits[digit], ch => parseInt(ch, 16) / 15);
    templateCache.set(key, t);
  }
  return t;
}

/** The ink (h rows of w columns, 1 = text) averaged over the window [x, x + p) onto the template grid. */
function cellOf(mid: Float32Array, w: number, x: number, p: number): Float32Array {
  const wx = binWeights(x, p, STAMP_COLS, w);
  const out = new Float32Array(STAMP_ROWS * STAMP_COLS);
  for (let i = 0; i < STAMP_ROWS; i++) {
    for (let j = 0; j < STAMP_COLS; j++) {
      const wr = wx[j];
      let s = 0;
      for (let c = 0; c < w; c++) if (wr[c] !== 0) s += wr[c] * mid[i * w + c];
      out[i * STAMP_COLS + j] = s;
    }
  }
  return out;
}

/**
 * The time "HH:MM:SS" at the start of a text line, given the line as ink (1 = text), `h` rows by `w` columns, trimmed to the
 * line's own rows. The six digits sit at fixed spacing (digit, digit, colon, digit, digit, colon, digit, digit); the spacing,
 * the start and the font are searched for the best fit. Null when nothing fits well enough or the time is not a time.
 */
export function readTimeFromInk(ink: Uint8Array, w: number, h: number): StampTime | null {
  let x0 = -1;
  for (let c = 0; c < w && x0 < 0; c++) for (let y = 0; y < h; y++) if (ink[y * w + c]) { x0 = c; break; }
  if (x0 < 0 || h < 6) return null;
  // the rows are averaged onto the template's rows once; only the columns change between candidates
  const wy = binWeights(0, h, STAMP_ROWS, h);
  const mid = new Float32Array(STAMP_ROWS * w);
  for (let i = 0; i < STAMP_ROWS; i++) {
    for (let y = 0; y < h; y++) {
      const f = wy[i][y];
      if (f === 0) continue;
      for (let c = 0; c < w; c++) mid[i * w + c] += f * ink[y * w + c];
    }
  }
  let best: { cost: number; digits: string } | null = null;
  for (const font of Object.keys(STAMP_FONTS)) {
    const { colonRatio, widthOverHeight } = STAMP_FONTS[font];
    const p0 = widthOverHeight * h;
    for (let p = p0 * 0.92; p <= p0 * 1.08; p += 0.1) {
      const c = colonRatio * p;
      const starts = [0, p, 2 * p + c, 3 * p + c, 4 * p + 2 * c, 5 * p + 2 * c];
      for (let d = -3; d < 3; d++) {
        let cost = 0;
        let digits = '';
        for (const s of starts) {
          const cell = cellOf(mid, w, x0 + d + s, p);
          let bestErr = Infinity;
          let bestDigit = '0';
          for (let k = 0; k < 10; k++) {
            const t = template(font, String(k));
            let e = 0;
            for (let i = 0; i < cell.length; i++) e += Math.abs(cell[i] - t[i]);
            e /= cell.length;
            if (e < bestErr) { bestErr = e; bestDigit = String(k); }
          }
          cost += bestErr;
          digits += bestDigit;
          if (best && cost >= best.cost) break;
        }
        if (digits.length === 6 && (!best || cost < best.cost)) best = { cost, digits };
      }
    }
  }
  if (!best || best.cost / 6 > MAX_CELL_ERROR) return null;
  const hours = +best.digits.slice(0, 2);
  const minutes = +best.digits.slice(2, 4);
  const seconds = +best.digits.slice(4, 6);
  return hours < 24 && minutes < 60 && seconds < 60 ? { hours, minutes, seconds } : null;
}

/** The scan time printed in `box` of a decoded picture (RGBA, `w` x `h`): the last line of text in the box. */
export function readStampTime(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, box: StampBox): StampTime | null {
  const x1 = Math.min(w, box.x + box.w);
  const y1 = Math.min(h, box.y + box.h);
  const bw = x1 - box.x;
  const bh = y1 - box.y;
  if (bw < 20 || bh < 6) return null;
  const ink = new Uint8Array(bw * bh);
  const rows = new Uint8Array(bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((box.y + y) * w + box.x + x) * 4;
      const grey = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
      if (grey < INK_BELOW) { ink[y * bw + x] = 1; rows[y] = 1; }
    }
  }
  let last = bh - 1;
  while (last >= 0 && !rows[last]) last--;
  if (last < 0) return null;
  let first = last;
  while (first > 0 && rows[first - 1]) first--;
  return readTimeFromInk(ink.subarray(first * bw, (last + 1) * bw), bw, last - first + 1);
}

/**
 * The moment of a printed UTC time: the latest day on which it is not after `referenceMs` (when the picture was served, a few
 * minutes of clock slack allowed). A scan is never newer than the file that carries it, and a day-old picture is not shown anyway.
 */
export function stampEpoch(t: StampTime, referenceMs: number): number {
  const slack = 5 * 60_000;
  const day = Math.floor((referenceMs + slack) / 86_400_000) * 86_400_000;
  const epoch = day + ((t.hours * 60 + t.minutes) * 60 + t.seconds) * 1000;
  return epoch > referenceMs + slack ? epoch - 86_400_000 : epoch;
}
