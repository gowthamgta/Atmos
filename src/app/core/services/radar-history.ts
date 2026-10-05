/**
 * The last hour of IMD radar. IMD only publishes each radar's latest picture as a still, but it also publishes an
 * animated GIF of the recent scans (radar/animation/Converted/<CODE>_MAXZ.gif and _SRI.gif). Every frame is a
 * full picture in the same layout as the still, and carries its scan time (IST) in a GIF comment, in order.
 * These helpers read those times and choose which frames make up the one-hour loop.
 */
import type { RadarProductKey } from '../domain/models/radar.model';

export const HISTORY_WINDOW_MIN = 60;
/** The loop's time step; IMD radars scan about every 10 minutes. */
export const HISTORY_STEP_MIN = 10;
/** A radar's scan is used for a loop step if it is at most this much older than the step. */
export const HISTORY_MAX_LAG_MIN = 15;

/** Animated GIF of a radar's recent scans, or null when IMD has none for this product. */
export function animationFile(stationCode: string, product: RadarProductKey): string | null {
  const suffix = product === 'caz' ? 'MAXZ' : product === 'sri' ? 'SRI' : null;
  return suffix ? `animation/Converted/${stationCode.toUpperCase()}_${suffix}.gif` : null;
}

/** "2026-10-05T12:32:23" (IST, as IMD writes it) to epoch ms, or null. */
export function parseIstStamp(text: string): number | null {
  const m = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (!m) return null;
  const ms = Date.parse(`${m[0]}+05:30`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Scan time of every frame of a GIF, in frame order (null where a frame has no time). Walks the GIF block
 * structure: a comment extension (0x21 0xFE) before an image descriptor (0x2C) belongs to that frame.
 */
export function gifFrameTimestamps(bytes: Uint8Array): (number | null)[] {
  const out: (number | null)[] = [];
  if (bytes.length < 13 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return out;
  let p = 13;
  const flags = bytes[10];
  if (flags & 0x80) p += 3 * (1 << ((flags & 0x07) + 1)); // global colour table
  const skipSubBlocks = (q: number): [number, string] => {
    let text = '';
    while (q < bytes.length) {
      const size = bytes[q++];
      if (size === 0) break;
      for (let i = 0; i < size && q + i < bytes.length; i++) text += String.fromCharCode(bytes[q + i]);
      q += size;
    }
    return [q, text];
  };
  let pending: number | null = null;
  while (p < bytes.length) {
    const b = bytes[p];
    if (b === 0x3b) break; // trailer
    if (b === 0x21) {
      const label = bytes[p + 1];
      const [next, text] = skipSubBlocks(p + 2);
      if (label === 0xfe) pending = parseIstStamp(text);
      p = next;
    } else if (b === 0x2c) {
      out.push(pending);
      pending = null;
      const packed = bytes[p + 9];
      p += 10;
      if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1)); // local colour table
      p += 1; // LZW minimum code size
      p = skipSubBlocks(p)[0];
    } else {
      break; // not a GIF block: stop rather than misread
    }
  }
  return out;
}

/**
 * Frames to use from one radar's animation: the last frame of each distinct scan time within `windowMin` of the
 * newest one, oldest first. IMD repeats frames when a scan is missing, so equal times are merged.
 */
export function recentFrames(times: readonly (number | null)[], windowMin = HISTORY_WINDOW_MIN): { index: number; timeMs: number }[] {
  let newest = -Infinity;
  for (const t of times) if (t !== null && t > newest) newest = t;
  if (!Number.isFinite(newest)) return [];
  const byTime = new Map<number, number>();
  times.forEach((t, i) => {
    if (t !== null && newest - t <= windowMin * 60_000) byTime.set(t, i);
  });
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([timeMs, index]) => ({ index, timeMs }));
}

/** Loop step times (epoch ms, oldest first): every `stepMin` back from the newest scan, covering `windowMin`. */
export function historySlots(newestMs: number, windowMin = HISTORY_WINDOW_MIN, stepMin = HISTORY_STEP_MIN): number[] {
  const n = Math.floor(windowMin / stepMin);
  return Array.from({ length: n + 1 }, (_, i) => newestMs - (n - i) * stepMin * 60_000);
}

/** The newest scan at or before `slotMs` and not older than `maxLagMin` before it, or null. */
export function scanForSlot<T extends { timeMs: number }>(scans: readonly T[], slotMs: number, maxLagMin = HISTORY_MAX_LAG_MIN): T | null {
  let best: T | null = null;
  for (const s of scans) {
    if (s.timeMs <= slotMs + 30_000 && slotMs - s.timeMs <= maxLagMin * 60_000 && (!best || s.timeMs > best.timeMs)) best = s;
  }
  return best;
}
