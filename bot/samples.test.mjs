import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALERT_COOLDOWN_MS, GAUGE_POINTS, KEEP_MS, appendSamples, parsePlaces, placeAlert } from './samples.mjs';

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

test('reads the owner’s places', () => {
  assert.deepEqual(parsePlaces('Kallakurichi:11.74,78.96; Chennai:13.08,80.27;bad'), [
    { name: 'Kallakurichi', lat: 11.74, lon: 78.96 },
    { name: 'Chennai', lat: 13.08, lon: 80.27 },
  ]);
  assert.deepEqual(parsePlaces(undefined), []);
});

test('alerts when rain is about to reach a dry place, once in a while', () => {
  const place = { name: 'Kallakurichi', lat: 11.74, lon: 78.96 };
  const coming = { live: box(0), n30: box(0.6, 47), n60: box(0.8) };
  const text = placeAlert(place, coming, T, T, undefined);
  assert.match(text, /Kallakurichi within about 30 minutes/);
  assert.match(text, /heavy rain/);
  assert.equal(placeAlert(place, coming, T, T, T - ALERT_COOLDOWN_MS / 2), null); // told recently
  assert.match(placeAlert(place, { live: box(0), n30: box(0), n60: box(0.5, 30) }, T, T, undefined), /within about 60 minutes.*light rain/);
  assert.equal(placeAlert(place, { live: box(0.7), n30: box(0.9), n60: box(0.9) }, T, T, undefined), null); // already raining there
  assert.equal(placeAlert(place, { live: box(0), n30: box(0.1), n60: box(0.1) }, T, T, undefined), null); // no rain coming
  assert.equal(placeAlert(place, { live: null, n30: null, n60: null }, T, T, undefined), null); // beyond the radar
});
