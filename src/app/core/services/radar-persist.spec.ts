import { describe, expect, it } from 'vitest';
import { RADAR_FIELD_SIZE } from './radar-process';
import { PERSIST_MIN_SCANS, PERSIST_SIZE, clearCells, decodePersist, encodePersist, newPersistState, persistLevels, persistentCells, updatePersist } from './radar-persist';

const N = RADAR_FIELD_SIZE;
/** Whole 1024 x 1024 fields over dozens of scans: seconds on a busy machine, so more than the default 5 s. */
const HEAVY_MS = 30_000;
const intensity = (dbz: number) => (dbz - 12) / 9.6;
/** A field with square blobs: [x, y, half-width, dBZ] in field pixels. */
const field = (blobs: [number, number, number, number][]) => {
  const f = new Float32Array(N * N);
  for (const [cx, cy, r, dbz] of blobs) for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) f[y * N + x] = intensity(dbz);
  return f;
};
/** Runs scans through a fresh memory and returns what the last one would lose (field pixels). */
const run = (scans: Float32Array[]) => {
  const st = newPersistState();
  let lost = 0;
  scans.forEach((f, i) => {
    const levels = persistLevels(f);
    updatePersist(st, levels, (i + 1) * 600_000);
    lost = clearCells(f, persistentCells(st, levels));
  });
  return { st, lost, last: scans[scans.length - 1] };
};

describe('echo that stays put', () => {
  it('removes clutter that shows the same strength scan after scan, once it has been there long enough', () => {
    const scans = Array.from({ length: PERSIST_MIN_SCANS }, (_, i) => field([[300, 300, 6, 40 + (i % 2)]]));
    const { lost, last } = run(scans);
    expect(lost).toBeGreaterThan(0);
    expect(last.every(v => v === 0)).toBe(true);
    // one scan fewer: not yet
    expect(run(Array.from({ length: PERSIST_MIN_SCANS - 1 }, () => field([[300, 300, 6, 40]]))).lost).toBe(0);
  }, HEAVY_MS);

  it('keeps clutter that flickers out now and then counted, and rain that moves or changes untouched', () => {
    // clutter missing in one scan of four still gets there, a few scans later
    const flicker = Array.from({ length: PERSIST_MIN_SCANS * 2 + 1 }, (_, i) => field(i % 4 === 3 ? [] : [[300, 300, 6, 40]]));
    expect(run(flicker).lost).toBeGreaterThan(0);
    // a cell moving 4 km a scan, and a cell staying put but changing strength by 10 dBZ between scans
    const moving = Array.from({ length: 30 }, (_, i) => field([[200 + i * 8, 500, 20, 45]]));
    expect(run(moving).lost).toBe(0);
    const pulsing = Array.from({ length: 30 }, (_, i) => field([[600, 600, 20, i % 2 ? 30 : 42]]));
    expect(run(pulsing).lost).toBe(0);
  }, HEAVY_MS);

  it('keeps a small steady spot inside moving rain (the patch is mostly not steady)', () => {
    const scans = Array.from({ length: 30 }, (_, i) => field([[400, 400, 60, 25 + (i % 3) * 8], [400, 400, 3, 45]]));
    const { lost } = run(scans);
    expect(lost).toBe(0);
  }, HEAVY_MS);

  it('carries the memory from run to run', () => {
    const { st } = run(Array.from({ length: 5 }, () => field([[300, 300, 6, 40]])));
    const back = decodePersist(encodePersist(new Map([['karaikal:caz', st]])));
    expect(back.get('karaikal:caz')!.scanMs).toBe(st.scanMs);
    expect(back.get('karaikal:caz')!.count).toEqual(st.count);
    expect(back.get('karaikal:caz')!.level.length).toBe(PERSIST_SIZE * PERSIST_SIZE);
    expect(decodePersist(new Uint8Array([0, 0, 0, 2, 123, 125])).size).toBe(0);
  }, HEAVY_MS);
});
