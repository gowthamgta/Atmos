// The satellite against the radar, kept by the nowcast bot for learning the synthetic radar (src/app/core/satellite/rain-features.ts gives
// them, pipeline/learn_rain.py learns from them). One file a satellite frame, gzipped JSON, at YYYY/MM/DD/HHMM.json.gz (UTC, the frame's
// time) in the rain-pairs branch (.github/workflows/nowcast.yml commits them). A frame already kept is not kept again.
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

/** Where a frame's pairs go, under dir. */
export function pairsPath(dir, satTimeMs) {
  const d = new Date(satTimeMs);
  const p = n => String(n).padStart(2, '0');
  return join(dir, String(d.getUTCFullYear()), p(d.getUTCMonth() + 1), p(d.getUTCDate()), `${p(d.getUTCHours())}${p(d.getUTCMinutes())}.json.gz`);
}

/** Whether pairs are worth keeping: from a frame and a radar picture close in time, with rows. */
export function usablePairs(pairs, maxGapMin = 6) {
  if (!pairs || !Number.isFinite(pairs.satTimeMs) || !Number.isFinite(pairs.radarTimeMs) || !(pairs.rows > 0)) return false;
  return Math.abs(pairs.satTimeMs - pairs.radarTimeMs) <= maxGapMin * 60_000;
}

/** Writes the pairs (once a frame); returns the file written, or null when there was nothing new. */
export async function savePairs(dir, pairs) {
  if (!usablePairs(pairs)) return null;
  const file = pairsPath(dir, pairs.satTimeMs);
  try {
    await stat(file);
    return null; // this frame is kept already (from an earlier look)
  } catch {
    // new
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, gzipSync(JSON.stringify(pairs), { level: 9 }));
  return file;
}
