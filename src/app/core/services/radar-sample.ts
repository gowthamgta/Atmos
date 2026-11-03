import type { RadarDisplayFrame } from './radar.service';

/**
 * The radar's rain at a point: the rate of an echo for Z = a R^1.6 (each radar's a as last fitted to the Tamil Nadu gauges, else
 * Marshall-Palmer's) and the last hour's rain from the loop's pictures.
 */
export const ZR_B = 1.6;
export const ZR_EXP = 1 / ZR_B;

/** dBZ of a byte of a display frame (0: no echo), as the map's colour scale reads it (dBZ = 12 + 9.6 x intensity, intensity = byte / 255 x 6). */
export function byteToDbz(byte: number): number | null {
  return byte > 0 ? 12 + 9.6 * ((byte / 255) * 6) : null;
}

/** Marshall-Palmer's Z = 200 R^1.6: the rain rate where a radar has no fitted relation of its own. */
export const MARSHALL_PALMER_A = 200;

/** Rain rate (mm/h) of an echo of `dbz` for Z = a R^1.6. */
export function rainRate(dbz: number, a = MARSHALL_PALMER_A): number {
  return (Math.pow(10, dbz / 10) / a) ** ZR_EXP;
}

/** The dBZ under one point of a frame (null: no echo, or off the frame). */
export function dbzAt(frame: RadarDisplayFrame, lat: number, lon: number): number | null {
  const [[west, north], [east], [, south]] = frame.coordinates;
  if (lat < south || lat > north || lon < west || lon > east) return null;
  const y = Math.round(((north - lat) / (north - south)) * (frame.height - 1));
  const x = Math.round(((lon - west) / (east - west)) * (frame.width - 1));
  return byteToDbz(frame.field[y * frame.width + x]);
}

/**
 * The radar's rain at a point over the last hour (mm): each picture's rate for the minutes until the next (at most 15), from the loop's frames and
 * the live picture. Null without enough pictures to cover most of the hour.
 */
export function lastHourRain(frames: readonly RadarDisplayFrame[], lat: number, lon: number, a: number): number | null {
  const timed = frames.filter(f => f.timeMs !== null).sort((x, y) => x.timeMs! - y.timeMs!);
  if (timed.length < 3) return null;
  const end = timed[timed.length - 1].timeMs!;
  const start = end - 3_600_000;
  let mm = 0;
  let covered = 0;
  for (let i = 0; i < timed.length - 1; i++) {
    const t = timed[i].timeMs!;
    if (t < start) continue;
    const minutes = Math.min((timed[i + 1].timeMs! - t) / 60_000, 15);
    covered += minutes;
    const dbz = dbzAt(timed[i], lat, lon);
    if (dbz !== null) mm += rainRate(dbz, a) * (minutes / 60);
  }
  return covered >= 40 ? mm : null;
}
