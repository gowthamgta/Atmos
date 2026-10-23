import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { pairsPath, savePairs, usablePairs } from './pairs.mjs';

const T = Date.UTC(2026, 9, 23, 9, 45);
const pairs = (radarTimeMs = T + 4 * 60_000, rows = 2) => ({ satTimeMs: T, radarTimeMs, features: ['t108'], meta: ['dbzMax'], rows, cols: { t108: [210, 290], dbzMax: [40, 0] } });

test('one file a satellite frame, by its UTC time', () => {
  assert.equal(pairsPath('/x', T), join('/x', '2026', '10', '23', '0945.json.gz'));
});

test('keeps only a radar picture close to the frame, with rows', () => {
  assert.ok(usablePairs(pairs()));
  assert.ok(!usablePairs(pairs(T + 9 * 60_000)));
  assert.ok(!usablePairs(pairs(T, 0)));
  assert.ok(!usablePairs(null));
});

test('writes a frame once, gzipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pairs-'));
  const file = await savePairs(dir, pairs());
  assert.ok(file);
  assert.deepEqual(JSON.parse(gunzipSync(await readFile(file)).toString()).cols.t108, [210, 290]);
  assert.equal(await savePairs(dir, pairs()), null);
});
