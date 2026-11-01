/**
 * Clutter that stays put (the owner, 1 Nov 2026: "look for the non changing ones, keep the changing ones"). Rain moves and changes from
 * scan to scan; ground clutter (hills, towers, buildings near a radar) and a fixed interference sit on the same pixels with nearly the same
 * strength scan after scan, cloud or no cloud. The radar workflow keeps, for each radar product, how many scans in a row each cell has shown
 * echo of the same strength (PersistState, carried from run to run), and removes the echo of cells that have been steady for a long time.
 * The same idea as the clutter maps weather services build from echo that persists (e.g. Canada's and MRMS's quality control).
 *
 * Erring on the side of keeping rain:
 *  - a cell counts as steady only within PERSIST_TOLERANCE_DBZ of its own level, scan after scan, and is removed only after
 *    PERSIST_MIN_SCANS such scans (about three hours at IMD's 10 minutes): rain is not that still at one place;
 *  - a scan of another strength takes 3 off the count (rain passing over the place); a scan without echo only 1 (clutter comes and goes a little);
 *  - in a patch of echo (connected cells) steady cells are removed only when they are at least half of the patch, so steady cells by chance
 *    inside moving rain stay; a patch steady almost all through is removed whole.
 * Only a new picture counts (the same picture again, or a frozen one, changes nothing).
 */
import { RADAR_FIELD_SIZE } from './radar-process';

/** The state's grid: the field's 1024 pixels in 2 x 2 blocks (0.5 to 2 km a cell depending on the product's range). */
export const PERSIST_SIZE = RADAR_FIELD_SIZE / 2;
/** Steady: within this of the cell's level (dBZ). IMD's legends step about 5 dBZ, so this is "the same colour". */
export const PERSIST_TOLERANCE_DBZ = 3;
/** Steady scans (the first sighting counts 1; see updatePersist for what counts down) before a cell's echo is taken for clutter. */
export const PERSIST_MIN_SCANS = 18;
/** In a patch, steady cells go when they are this share of it; the whole patch goes from PERSIST_PATCH_ALL. */
export const PERSIST_PATCH_SHARE = 0.5;
export const PERSIST_PATCH_ALL = 0.8;

/** One radar product's memory: each cell's level (dBZ rounded, 0: none yet) and its steady count, and the scan it was last updated with. */
export interface PersistState {
  level: Uint8Array;
  count: Uint8Array;
  scanMs: number;
}

export function newPersistState(): PersistState {
  return { level: new Uint8Array(PERSIST_SIZE * PERSIST_SIZE), count: new Uint8Array(PERSIST_SIZE * PERSIST_SIZE), scanMs: 0 };
}

/** A field's levels on the state's grid: the strongest of each 2 x 2 block, in dBZ rounded (0: no echo). The field is (dBZ - 12) / 9.6. */
export function persistLevels(field: Float32Array, size = RADAR_FIELD_SIZE): Uint8Array {
  const n = PERSIST_SIZE, k = size / n;
  const out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let m = 0;
      for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) m = Math.max(m, field[(y * k + dy) * size + x * k + dx]);
      if (m > 0) out[y * n + x] = Math.min(255, Math.max(1, Math.round(m * 9.6 + 12)));
    }
  }
  return out;
}

/** Adds a new scan's levels to the state (call once per new picture). */
export function updatePersist(state: PersistState, levels: Uint8Array, scanMs: number): void {
  const { level, count } = state;
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i], p = level[i], c = count[i];
    if (l > 0) {
      if (p > 0 && Math.abs(l - p) <= PERSIST_TOLERANCE_DBZ) {
        count[i] = Math.min(255, c + 1); // the level stays the first one seen, so a slow drift does not carry it along
      } else if (c > 3) {
        count[i] = c - 3;
      } else {
        level[i] = l; // a new level: counted from here
        count[i] = 1;
      }
    } else if (c > 0) {
      count[i] = c - 1;
      if (count[i] === 0) level[i] = 0;
    } else {
      level[i] = 0;
    }
  }
  state.scanMs = scanMs;
}

/** The cells of a scan taken for clutter (1): steady long enough and at their level now, by the patch rule above. */
export function persistentCells(state: PersistState, levels: Uint8Array): Uint8Array {
  const n = PERSIST_SIZE;
  const steady = new Uint8Array(n * n);
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] > 0 && state.count[i] >= PERSIST_MIN_SCANS && Math.abs(levels[i] - state.level[i]) <= PERSIST_TOLERANCE_DBZ) steady[i] = 1;
  }
  const out = new Uint8Array(n * n);
  const seen = new Uint8Array(n * n);
  const stack = new Int32Array(n * n);
  const members: number[] = [];
  for (let start = 0; start < n * n; start++) {
    if (!steady[start] || seen[start]) continue; // a patch without a steady cell has nothing to remove
    let top = 0, steadyCount = 0;
    stack[top++] = start;
    seen[start] = 1;
    members.length = 0;
    while (top > 0) {
      const i = stack[--top];
      members.push(i);
      steadyCount += steady[i];
      const x = i % n, y = (i - x) / n;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= n) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= n) continue;
          const j = yy * n + xx;
          if (!seen[j] && levels[j] > 0) {
            seen[j] = 1;
            stack[top++] = j;
          }
        }
      }
    }
    const share = steadyCount / members.length;
    if (share >= PERSIST_PATCH_ALL) for (const i of members) out[i] = 1;
    else if (share >= PERSIST_PATCH_SHARE) for (const i of members) out[i] = steady[i];
  }
  return out;
}

/** Clears the field's pixels under the given cells; returns the number of field pixels cleared. */
export function clearCells(field: Float32Array, cells: Uint8Array, size = RADAR_FIELD_SIZE): number {
  const n = PERSIST_SIZE, k = size / n;
  let cleared = 0;
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) continue;
    const x = i % n, y = (i - x) / n;
    for (let dy = 0; dy < k; dy++) {
      for (let dx = 0; dx < k; dx++) {
        const j = (y * k + dy) * size + x * k + dx;
        if (field[j] > 0) cleared++;
        field[j] = 0;
      }
    }
  }
  return cleared;
}

/** A state older than this is started again (a radar back after a long time may have moved its picture). */
export const PERSIST_MAX_AGE_MS = 12 * 3_600_000;

/** Every product's state in one buffer (the radar workflow publishes it for its next run): a JSON header, then each level and count. */
export function encodePersist(states: ReadonlyMap<string, PersistState>): Uint8Array {
  const keys = [...states.keys()];
  const header = new TextEncoder().encode(JSON.stringify({ v: 1, size: PERSIST_SIZE, products: keys.map(k => [k, states.get(k)!.scanMs]) }));
  const cells = PERSIST_SIZE * PERSIST_SIZE;
  const out = new Uint8Array(4 + header.length + keys.length * 2 * cells);
  new DataView(out.buffer).setUint32(0, header.length);
  out.set(header, 4);
  keys.forEach((k, i) => {
    const s = states.get(k)!;
    out.set(s.level, 4 + header.length + i * 2 * cells);
    out.set(s.count, 4 + header.length + i * 2 * cells + cells);
  });
  return out;
}

/** The states back from encodePersist (empty when the buffer is not one, or of another grid). */
export function decodePersist(bytes: Uint8Array): Map<string, PersistState> {
  const states = new Map<string, PersistState>();
  try {
    const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len))) as { v: number; size: number; products: [string, number][] };
    const cells = PERSIST_SIZE * PERSIST_SIZE;
    if (header.v !== 1 || header.size !== PERSIST_SIZE || bytes.length !== 4 + len + header.products.length * 2 * cells) return states;
    header.products.forEach(([key, scanMs], i) => {
      const at = 4 + len + i * 2 * cells;
      states.set(key, { level: bytes.slice(at, at + cells), count: bytes.slice(at + cells, at + 2 * cells), scanMs });
    });
  } catch {
    // not a state file: start again
  }
  return states;
}
