/**
 * The drawing maths of the meteogram: scales with round ticks, smooth lines that break where a model has no value, rain bars, and the hours of
 * day and night. All pure functions of numbers, so the chart is tested without a browser, and the component only places what these return.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * HOUR_MS;

/** A step of 1, 2 or 5 times a power of ten that gives about `count` steps over a range. */
export function niceStep(range: number, count: number): number {
  const raw = Math.max(range, 1e-9) / Math.max(count, 1);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const frac = raw / pow;
  return (frac < 1.5 ? 1 : frac < 3.5 ? 2 : frac < 7.5 ? 5 : 10) * pow;
}

export interface Scale {
  min: number;
  max: number;
  ticks: number[];
  step: number;
}

export interface ScaleOptions {
  /** The scale starts at 0 (rain, wind). */
  zeroBased?: boolean;
  /** The least range shown, so a calm day does not stretch a degree to the height of the chart. */
  minSpan?: number;
  /** About how many ticks. */
  count?: number;
  /** Whether ticks must be whole numbers (a wind in Beaufort). */
  integer?: boolean;
}

/** A scale that covers [lo, hi] and starts and ends on a tick. */
export function niceScale(lo: number, hi: number, opts: ScaleOptions = {}): Scale {
  const { zeroBased = false, minSpan = 0, count = 4, integer = false } = opts;
  if (zeroBased) lo = Math.min(lo, 0);
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = zeroBased ? lo : mid - minSpan / 2;
    hi = zeroBased ? lo + minSpan : mid + minSpan / 2;
  }
  let step = niceStep(hi - lo, count);
  if (integer) step = Math.max(1, Math.round(step));
  const min = zeroBased ? Math.min(0, Math.floor(lo / step) * step) : Math.floor(lo / step) * step;
  let max = Math.ceil(hi / step) * step;
  if (max <= min) max = min + step;
  const ticks: number[] = [];
  for (let k = Math.round(min / step); k * step <= max + step * 1e-9; k++) ticks.push(Math.round(k * step * 1e9) / 1e9 || 0);
  return { min: ticks[0], max: ticks[ticks.length - 1], ticks, step };
}

export interface Pt {
  x: number;
  /** Null where there is no value: the line stops there. */
  y: number | null;
}

const r = (n: number): string => String(Math.round(n * 10) / 10);

/** The sign of a number: -1, 0 or 1. */
const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** One unbroken run of points as a smooth path that never overshoots its points (monotone cubic, the same curve as d3's curveMonotoneX). */
function smoothRun(run: { x: number; y: number }[]): string {
  const n = run.length;
  if (n === 1) return `M${r(run[0].x)} ${r(run[0].y)}`;
  if (n === 2) return `M${r(run[0].x)} ${r(run[0].y)}L${r(run[1].x)} ${r(run[1].y)}`;
  const h: number[] = [];
  const s: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(run[i + 1].x - run[i].x);
    s.push(h[i] === 0 ? 0 : (run[i + 1].y - run[i].y) / h[i]);
  }
  const t: number[] = new Array<number>(n);
  for (let i = 1; i < n - 1; i++) {
    const p = (s[i - 1] * h[i] + s[i] * h[i - 1]) / (h[i - 1] + h[i] || 1);
    t[i] = (sign(s[i - 1]) + sign(s[i])) * Math.min(Math.abs(s[i - 1]), Math.abs(s[i]), 0.5 * Math.abs(p)) || 0;
  }
  t[0] = h[0] ? (3 * s[0] - t[1]) / 2 : t[1];
  t[n - 1] = h[n - 2] ? (3 * s[n - 2] - t[n - 2]) / 2 : t[n - 2];
  let d = `M${r(run[0].x)} ${r(run[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = h[i] / 3;
    d += `C${r(run[i].x + dx)} ${r(run[i].y + t[i] * dx)} ${r(run[i + 1].x - dx)} ${r(run[i + 1].y - t[i + 1] * dx)} ${r(run[i + 1].x)} ${r(run[i + 1].y)}`;
  }
  return d;
}

/** Splits points into the runs between gaps (a point with no value). */
function runsOf(points: readonly Pt[]): { x: number; y: number }[][] {
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  for (const p of points) {
    if (p.y === null || !Number.isFinite(p.y)) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push({ x: p.x, y: p.y });
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

/** A line through the points, smooth or straight; it is broken wherever a point has no value. Empty when there is nothing to draw. */
export function linePath(points: readonly Pt[], smooth = true): string {
  return runsOf(points)
    .map(run => (smooth ? smoothRun(run) : `M${run.map(p => `${r(p.x)} ${r(p.y)}`).join('L')}`))
    .join('');
}

/** The area between a line and a baseline, closed, for each unbroken run. */
export function areaPath(points: readonly Pt[], baseY: number, smooth = true): string {
  return runsOf(points)
    .filter(run => run.length > 1)
    .map(run => {
      const top = smooth ? smoothRun(run) : `M${run.map(p => `${r(p.x)} ${r(p.y)}`).join('L')}`;
      return `${top}L${r(run[run.length - 1].x)} ${r(baseY)}L${r(run[0].x)} ${r(baseY)}Z`;
    })
    .join('');
}

/** The area between two lines (gusts above the wind): both given at the same x values. */
export function bandPath(upper: readonly Pt[], lower: readonly Pt[], smooth = true): string {
  const out: string[] = [];
  let i = 0;
  while (i < upper.length) {
    if (upper[i].y === null || lower[i].y === null) {
      i++;
      continue;
    }
    const top: Pt[] = [];
    const bottom: Pt[] = [];
    while (i < upper.length && upper[i].y !== null && lower[i].y !== null) {
      top.push(upper[i]);
      bottom.push(lower[i]);
      i++;
    }
    if (top.length < 2) continue;
    const forward = smooth ? smoothRun(top as { x: number; y: number }[]) : `M${top.map(p => `${r(p.x)} ${r(p.y as number)}`).join('L')}`;
    const back = bottom
      .reverse()
      .map(p => `L${r(p.x)} ${r(p.y as number)}`)
      .join('');
    out.push(`${forward}${back}Z`);
  }
  return out.join('');
}

/**
 * Bars standing on a baseline, as one path. `width` is the width of each (a pixel less than the space between hours leaves a hairline between
 * neighbours). A value too small to show is lifted to a hairline when it is above zero, so a trace of rain is not lost.
 */
export function barsPath(points: readonly Pt[], baseY: number, width: number, minHeight = 1.5): string {
  const parts: string[] = [];
  for (const p of points) {
    if (p.y === null || !Number.isFinite(p.y)) continue;
    const height = baseY - p.y;
    if (height <= 0.05) continue;
    const top = baseY - Math.max(height, minHeight);
    parts.push(`M${r(p.x - width / 2)} ${r(baseY)}V${r(top)}H${r(p.x + width / 2)}V${r(baseY)}Z`);
  }
  return parts.join('');
}

/** A straight mapping of [d0, d1] onto [r0, r1]. */
export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return v => r0 + (v - d0) * k;
}

// ---- days and nights -----------------------------------------------------------------------------------------------

/** The IST midnight at or before a time. */
export function istDayStart(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

export interface DaySpan {
  /** IST midnight the day starts at. */
  startMs: number;
  /** Where the day shows inside the window. */
  fromMs: number;
  toMs: number;
}

/** The IST days a window covers, each cut to the window. */
export function daySpans(startMs: number, endMs: number): DaySpan[] {
  const out: DaySpan[] = [];
  for (let d = istDayStart(startMs); d < endMs; d += DAY_MS) out.push({ startMs: d, fromMs: Math.max(d, startMs), toMs: Math.min(d + DAY_MS, endMs) });
  return out;
}

/**
 * Sunrise and sunset at a place on the day containing `dayMs` (epoch ms), in epoch ms: the sunrise equation as in SunCalc (MIT), good to a
 * few minutes in the tropics. Null for a day without a sunrise or a sunset (polar, which this app never shows).
 */
export function sunTimes(lat: number, lon: number, dayMs: number): { sunrise: number; sunset: number } | null {
  const rad = Math.PI / 180;
  const J1970 = 2440588;
  const J2000 = 2451545;
  const J0 = 0.0009;
  const lw = rad * -lon;
  const phi = rad * lat;
  const d = dayMs / DAY_MS - 0.5 + J1970 - J2000;
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const approxTransit = (ht: number): number => J0 + (ht + lw) / (2 * Math.PI) + n;
  const ds = approxTransit(0);
  const M = rad * (357.5291 + 0.98560028 * ds);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(L) * Math.sin(rad * 23.4397));
  const transit = (x: number): number => J2000 + x + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const cosW = (Math.sin(-0.833 * rad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (Math.abs(cosW) > 1) return null;
  const jNoon = transit(ds);
  const jSet = transit(approxTransit(Math.acos(cosW)));
  const jRise = jNoon - (jSet - jNoon);
  const toMs = (j: number): number => (j + 0.5 - J1970) * DAY_MS;
  return { sunrise: toMs(jRise), sunset: toMs(jSet) };
}

/** The stretches of night inside a window (from a sunset to the next sunrise), cut to the window. */
export function nightSpans(lat: number, lon: number, startMs: number, endMs: number): { fromMs: number; toMs: number }[] {
  const out: { fromMs: number; toMs: number }[] = [];
  // look one day either side so a night that began before the window, or ends after it, is found
  const times: { sunrise: number; sunset: number }[] = [];
  for (let d = istDayStart(startMs) - DAY_MS; d <= endMs + DAY_MS; d += DAY_MS) {
    const t = sunTimes(lat, lon, d + 12 * HOUR_MS); // at noon in India: the sun of that day
    if (t) times.push(t);
  }
  for (let i = 0; i < times.length - 1; i++) {
    const from = Math.max(times[i].sunset, startMs);
    const to = Math.min(times[i + 1].sunrise, endMs);
    if (to > from) out.push({ fromMs: from, toMs: to });
  }
  return out;
}

// ---- reading the chart ---------------------------------------------------------------------------------------------

/** The hour index nearest to an x position, for hourly points spread evenly from x0 to x1. */
export function hourAtX(x: number, x0: number, x1: number, count: number): number {
  if (count <= 1 || x1 <= x0) return 0;
  const i = Math.round(((x - x0) / (x1 - x0)) * (count - 1));
  return Math.min(Math.max(i, 0), count - 1);
}

/** Every `k`th item so that items stay at least `minGap` px apart when spaced `spacing` px: for the wind arrows and the hour labels. */
export function everyNth(spacing: number, minGap: number, choices: readonly number[] = [1, 2, 3, 6, 12, 24]): number {
  return choices.find(k => k * spacing >= minGap) ?? choices[choices.length - 1];
}

/** "3 PM", "12 AM": the hour of an IST time, as on the time bar. */
export function istHour12(ms: number): string {
  const h = new Date(ms + IST_OFFSET_MS).getUTCHours();
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
}
