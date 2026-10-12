/**
 * Timing for the tests that guard the speed of the map. A busy machine (the whole suite runs its files side by side) only ever makes a run
 * slower, never faster, so the fastest of several batches is the honest figure for what the code costs; the mean of one batch would fail a
 * test for the load of the others.
 */
export function bestMs(batches: number, runsPerBatch: number, work: () => void): number {
  let best = Infinity;
  for (let b = 0; b < batches; b++) {
    const t0 = performance.now();
    for (let i = 0; i < runsPerBatch; i++) work();
    best = Math.min(best, (performance.now() - t0) / runsPerBatch);
  }
  return best;
}
