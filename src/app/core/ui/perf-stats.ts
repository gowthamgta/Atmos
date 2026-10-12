/**
 * Numbers for how smoothly the map is drawing, from the times between frames. Pure, so the meter and the speed test are tested without a
 * browser. A gap over one second is the page being hidden or paused, not a slow frame: it is counted apart and left out of the figures.
 */
export interface FrameStats {
  /** Frames the figures are from. */
  frames: number;
  /** Frames per second, from the mean time between frames. */
  fps: number;
  meanMs: number;
  /** 95% of the frames took no longer than this. */
  p95Ms: number;
  worstMs: number;
  /** Frames that took longer than 33.4 ms (under 30 a second): the ones that look like a stutter. */
  slowFrames: number;
  /** Gaps over a second (the page was paused). */
  stalls: number;
}

/** The longest gap that is a slow frame rather than a pause. */
export const STALL_MS = 1000;
/** A frame longer than this is under 30 frames a second. */
export const SLOW_FRAME_MS = 33.4;

/** The figures of a run of frame intervals (ms). Null when there are no frames to speak of. */
export function frameStats(intervalsMs: readonly number[]): FrameStats | null {
  const frames = intervalsMs.filter(d => d > 0 && d <= STALL_MS);
  const stalls = intervalsMs.filter(d => d > STALL_MS).length;
  if (frames.length === 0) return null;
  const sorted = [...frames].sort((a, b) => a - b);
  const mean = frames.reduce((s, d) => s + d, 0) / frames.length;
  return {
    frames: frames.length,
    fps: 1000 / mean,
    meanMs: mean,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    worstMs: sorted[sorted.length - 1],
    slowFrames: frames.filter(d => d > SLOW_FRAME_MS).length,
    stalls,
  };
}

export type Grade = 'good' | 'fair' | 'poor';

/** A plain word for the figures: smooth (about 55 frames a second or more), noticeable (30 to 55), rough (under 30). */
export function gradeOf(stats: FrameStats): Grade {
  if (stats.fps >= 55 && stats.p95Ms <= 25) return 'good';
  if (stats.fps >= 30) return 'fair';
  return 'poor';
}

/** The share of frames that were slow, as a percentage. */
export function slowShare(stats: FrameStats): number {
  return (stats.slowFrames / stats.frames) * 100;
}
