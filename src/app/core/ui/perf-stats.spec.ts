import { describe, expect, it } from 'vitest';
import { frameStats, gradeOf, slowShare } from './perf-stats';

const steady = (ms: number, n: number): number[] => Array.from({ length: n }, () => ms);

describe('frame statistics', () => {
  it('gives sixty frames a second for frames 16.7 ms apart', () => {
    const s = frameStats(steady(16.667, 120))!;
    expect(s.fps).toBeCloseTo(60, 1);
    expect(s.p95Ms).toBeCloseTo(16.667, 3);
    expect(s.worstMs).toBeCloseTo(16.667, 3);
    expect(s.slowFrames).toBe(0);
    expect(gradeOf(s)).toBe('good');
  });

  it('counts the frames that stutter, and finds the 95th percentile', () => {
    // 95 smooth frames and 5 of 50 ms
    const s = frameStats([...steady(16, 95), ...steady(50, 5)])!;
    expect(s.frames).toBe(100);
    expect(s.slowFrames).toBe(5);
    expect(slowShare(s)).toBe(5);
    expect(s.p95Ms).toBe(16);                    // exactly 5% are slow: the 95th is the last smooth one
    expect(s.worstMs).toBe(50);
    const worse = frameStats([...steady(16, 90), ...steady(50, 10)])!;
    expect(worse.p95Ms).toBe(50);
  });

  it('does not count a pause (the page hidden) as a slow frame', () => {
    const s = frameStats([...steady(16.7, 60), 4000, ...steady(16.7, 60)])!;
    expect(s.stalls).toBe(1);
    expect(s.frames).toBe(120);
    expect(s.worstMs).toBeCloseTo(16.7, 3);
    expect(s.fps).toBeCloseTo(59.9, 0);
  });

  it('says nothing when there are no frames', () => {
    expect(frameStats([])).toBeNull();
    expect(frameStats([0, 0])).toBeNull();
    expect(frameStats([5000])).toBeNull();       // only a pause
  });

  it('grades the figures: smooth, noticeable, rough', () => {
    expect(gradeOf(frameStats(steady(16.7, 100))!)).toBe('good');
    expect(gradeOf(frameStats(steady(25, 100))!)).toBe('fair');                  // 40 a second
    expect(gradeOf(frameStats(steady(50, 100))!)).toBe('poor');                  // 20 a second
    // fast on average but with long frames in it: not smooth
    expect(gradeOf(frameStats([...steady(10, 90), ...steady(60, 10)])!)).toBe('fair');
  });
});
