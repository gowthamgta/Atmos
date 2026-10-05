import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Test helper: the real baked terrain raster, exactly as the app loads it at runtime. */
export function loadBakedTerrain(): Uint16Array {
  const file = resolve(process.cwd(), 'public/data/tn-elevation-500m.bin.gz');
  const raw = gunzipSync(readFileSync(file));
  return new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}
