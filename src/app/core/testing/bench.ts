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

/** A fixed piece of work (a pass of arithmetic over a 1 MB typed array) to measure how fast the machine is running right now. */
function referenceWork(): void {
  const a = new Float32Array(262_144);
  let s = 0;
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < a.length; i++) {
      a[i] = a[i] * 0.5 + i * 0.25;
      s += Math.sqrt(a[i]);
    }
  }
  if (s < 0) throw new Error('unreachable');
}

/** What referenceWork costs on an unloaded desktop (ms), the machine the budgets below were set on. */
export const REFERENCE_MS = 6.5;

/**
 * A time budget scaled to how loaded the machine is at this moment: `ms` on an unloaded desktop, more when the reference work runs slower
 * right now (the suite runs files side by side, so a test can find the machine busy for reasons of its own), never less than `ms`.
 */
export function loadScaledBudget(ms: number): number {
  const now = bestMs(5, 3, referenceWork);
  return ms * Math.max(1, now / REFERENCE_MS);
}
