import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GAUGE_POINTS, KEEP_MS, appendSamples } from './samples.mjs';

const T = Date.UTC(2026, 9, 22, 10, 0);
const box = (wet, max = 40) => ({ zp: 10, max, wet });
const look = (timeMs, n = GAUGE_POINTS.length) => ({ timeMs, live: Array(n).fill(box(0.5)), n30: Array(n).fill(null), n60: Array(n).fill(box(0)) });

test('the gauge cells cover Tamil Nadu on the gauge verification grid', () => {
  assert.ok(GAUGE_POINTS.length > 90);
  assert.deepEqual(GAUGE_POINTS[0], [8.25, 76.25]);
  assert.ok(GAUGE_POINTS.every(([la, lo]) => (la * 4) % 2 === 1 && (lo * 4) % 2 === 1)); // centres at x.25 and x.75, as verify_gauges.cell_of
});

test('keeps each radar picture once, packed, and forgets the old ones', () => {
  let s = appendSamples(null, look(T - 20 * 60_000), T);
  s = appendSamples(s, look(T - 20 * 60_000), T); // the same picture looked at again
  s = appendSamples(s, look(T - 10 * 60_000), T);
  s = appendSamples(s, { timeMs: null, live: [], n30: [], n60: [] }, T); // no picture
  assert.equal(s.records.length, 2);
  assert.deepEqual(s.records[0].live[0], [10, 40, 0.5]);
  assert.equal(s.records[0].n30[0], null);
  const later = appendSamples(s, look(T + KEEP_MS), T + KEEP_MS + 1);
  assert.deepEqual(later.records.map(r => r.t), [T + KEEP_MS]);
});
