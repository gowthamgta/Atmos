import { describe, expect, it } from 'vitest';
import { leadTimeLabel, runStartMs } from './forecast-timeline.component';

describe('forecast timeline helpers', () => {
  it('reads the start of a model run from its id', () => {
    expect(runStartMs('20261010T12Z')).toBe(Date.UTC(2026, 9, 10, 12));
    expect(runStartMs('20261010T1230Z')).toBe(Date.UTC(2026, 9, 10, 12, 30));
    expect(runStartMs('')).toBeNull();
    expect(runStartMs('latest')).toBeNull();
  });

  it('labels the lead time in hours since the run began', () => {
    const run = Date.UTC(2026, 9, 10, 0);
    expect(leadTimeLabel(run, run)).toBe('T+00 h');
    expect(leadTimeLabel(run + 6 * 3_600_000, run)).toBe('T+06 h');
    expect(leadTimeLabel(run + 126 * 3_600_000, run)).toBe('T+126 h');
    expect(leadTimeLabel(run - 3_600_000, run)).toBe('T−01 h');
  });
});
