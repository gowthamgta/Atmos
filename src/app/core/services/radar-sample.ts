import type { RadarDisplayFrame } from './radar.service';

/**
 * The radar over boxes around points, for the nowcast bot to keep (bot/nowcast.mjs) and the daily verification to use: calibrating the rain
 * rate against the Tamil Nadu gauges, and scoring the nowcast against the pictures that followed (pipeline/verify_radar.py).
 *
 * Per box: `zp`, the mean of Z^ZR_EXP over the box (Z in mm^6/m^3, no echo = 0), so the mean rain rate is zp / a^ZR_EXP for any a of
 * Z = a R^1.6 (the rate's exponent fixed, its factor fitted to the gauges); `max`, the strongest dBZ; `wet`, the share of the box with
 * RAIN_DBZ or more.
 */
export const ZR_B = 1.6;
export const ZR_EXP = 1 / ZR_B;
export const RAIN_DBZ = 25;
/** Samples a side in each box. */
const STEPS = 7;

export interface BoxSample {
  zp: number;
  max: number;
  wet: number;
}

/** dBZ of a byte of a display frame (0: no echo), as the map's colour scale reads it (dBZ = 12 + 9.6 x intensity, intensity = byte / 255 x 6). */
export function byteToDbz(byte: number): number | null {
  return byte > 0 ? 12 + 9.6 * ((byte / 255) * 6) : null;
}

/** The box of `halfDeg` around (lat, lon) on a frame (rows evenly spaced in latitude, columns in longitude); null when the box is off it. */
export function sampleBox(frame: RadarDisplayFrame, lat: number, lon: number, halfDeg: number): BoxSample | null {
  const [[west, north], [east], [, south]] = frame.coordinates;
  if (lat + halfDeg < south || lat - halfDeg > north || lon + halfDeg < west || lon - halfDeg > east) return null;
  let zp = 0;
  let max = 0;
  let wet = 0;
  let n = 0;
  for (let i = 0; i < STEPS; i++) {
    const la = lat - halfDeg + ((i + 0.5) / STEPS) * 2 * halfDeg;
    if (la < south || la > north) continue;
    const y = Math.round(((north - la) / (north - south)) * (frame.height - 1));
    for (let j = 0; j < STEPS; j++) {
      const lo = lon - halfDeg + ((j + 0.5) / STEPS) * 2 * halfDeg;
      if (lo < west || lo > east) continue;
      const x = Math.round(((lo - west) / (east - west)) * (frame.width - 1));
      const dbz = byteToDbz(frame.field[y * frame.width + x]);
      n++;
      if (dbz === null) continue;
      zp += Math.pow(10, dbz / 10) ** ZR_EXP;
      if (dbz > max) max = dbz;
      if (dbz >= RAIN_DBZ) wet++;
    }
  }
  if (n === 0) return null;
  return { zp: Math.round((zp / n) * 1000) / 1000, max: Math.round(max * 10) / 10, wet: Math.round((wet / n) * 1000) / 1000 };
}

/** Marshall-Palmer's Z = 200 R^1.6: the rain rate until the gauges have given each radar its own (pipeline/verify_radar.py). */
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

/** What the bot keeps from one look: the live picture's time, and the boxes on it and on the nowcast 30 and 60 minutes ahead. */
export interface RadarSamples {
  timeMs: number | null;
  live: (BoxSample | null)[];
  n30: (BoxSample | null)[];
  n60: (BoxSample | null)[];
}

export function sampleAll(
  live: RadarDisplayFrame | null,
  nowcast: readonly (RadarDisplayFrame & { leadMin: number })[],
  points: readonly [number, number][],
  halfDeg: number,
): RadarSamples {
  const at = (frame: RadarDisplayFrame | undefined | null) => points.map(([la, lo]) => (frame ? sampleBox(frame, la, lo, halfDeg) : null));
  return {
    timeMs: live?.timeMs ?? null,
    live: at(live),
    n30: at(nowcast.find(f => f.leadMin === 30)),
    n60: at(nowcast.find(f => f.leadMin === 60)),
  };
}
