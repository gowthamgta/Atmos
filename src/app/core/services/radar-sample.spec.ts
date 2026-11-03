import { describe, it, expect } from 'vitest';
import { MARSHALL_PALMER_A, ZR_EXP, byteToDbz, dbzAt, lastHourRain, rainRate } from './radar-sample';
import type { RadarDisplayFrame } from './radar.service';

/** A 101 x 101 frame over 10-11 N, 79-80 E: the west half `byte`, the east half empty. */
function frame(byte: number, timeMs = 1000): RadarDisplayFrame {
  const field = new Uint8Array(101 * 101);
  for (let y = 0; y < 101; y++) for (let x = 0; x < 50; x++) field[y * 101 + x] = byte;
  return { field, width: 101, height: 101, coordinates: [[79, 11], [80, 11], [80, 10], [79, 10]], timeMs };
}

const byteFor = (dbz: number) => Math.round((((dbz - 12) / 9.6) * 255) / 6);

describe('radar bytes', () => {
  it('reads bytes as the colour scale does', () => {
    expect(byteToDbz(0)).toBeNull();
    expect(byteToDbz(byteFor(40))).toBeCloseTo(40, 0);
  });
});

describe('rain from the radar', () => {
  it('turns dBZ into a rain rate with Z = a R^1.6', () => {
    // Marshall-Palmer: 23 dBZ is about 1 mm/h, 40 dBZ about 12 mm/h
    expect(rainRate(23)).toBeCloseTo(1, 0);
    expect(rainRate(40)).toBeCloseTo(11.5, 0);
    // a smaller a (more rain for the same echo, as tropical rain often is) gives more
    expect(rainRate(40, 100)).toBeGreaterThan(rainRate(40, MARSHALL_PALMER_A));
  });

  it('adds up the last hour of pictures at a point', () => {
    const f = (byte: number, min: number) => ({ ...frame(byte), timeMs: min * 60_000 });
    const frames = [0, 10, 20, 30, 40, 50, 60].map(m => f(m < 30 ? byteFor(40) : 0, m)); // 30 minutes of 40 dBZ, then dry
    expect(dbzAt(frames[0], 10.5, 79.2)).toBeCloseTo(40, 0);
    expect(dbzAt(frames[0], 10.5, 79.8)).toBeNull();
    const mm = lastHourRain(frames, 10.5, 79.2, MARSHALL_PALMER_A)!;
    expect(mm).toBeCloseTo(rainRate(byteToDbz(byteFor(40))!) / 2, 1);
    expect(lastHourRain(frames, 10.5, 79.8, MARSHALL_PALMER_A)).toBe(0);
    expect(lastHourRain(frames.slice(0, 2), 10.5, 79.2, MARSHALL_PALMER_A)).toBeNull(); // too few pictures
  });
});
