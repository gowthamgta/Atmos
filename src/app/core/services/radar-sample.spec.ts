import { describe, it, expect } from 'vitest';
import { MARSHALL_PALMER_A, RAIN_DBZ, ZR_EXP, byteToDbz, dbzAt, lastHourRain, rainRate, sampleAll, sampleBox } from './radar-sample';
import type { RadarDisplayFrame } from './radar.service';

/** A 101 x 101 frame over 10-11 N, 79-80 E: the west half `byte`, the east half empty. */
function frame(byte: number, timeMs = 1000): RadarDisplayFrame {
  const field = new Uint8Array(101 * 101);
  for (let y = 0; y < 101; y++) for (let x = 0; x < 50; x++) field[y * 101 + x] = byte;
  return { field, width: 101, height: 101, coordinates: [[79, 11], [80, 11], [80, 10], [79, 10]], timeMs };
}

const byteFor = (dbz: number) => Math.round((((dbz - 12) / 9.6) * 255) / 6);

describe('radar sampling for the bot', () => {
  it('reads bytes as the colour scale does', () => {
    expect(byteToDbz(0)).toBeNull();
    expect(byteToDbz(byteFor(40))).toBeCloseTo(40, 0);
  });

  it('averages Z^(1/1.6) over a box, with the strongest echo and the wet share', () => {
    const f = frame(byteFor(40));
    const west = sampleBox(f, 10.5, 79.2, 0.1)!; // all in the echo
    const dbz = byteToDbz(byteFor(40))!;
    expect(west.zp).toBeCloseTo(Math.pow(10, dbz / 10) ** ZR_EXP, 0);
    expect(west.max).toBeCloseTo(dbz, 1);
    expect(west.wet).toBe(1);
    const east = sampleBox(f, 10.5, 79.8, 0.1)!; // no echo
    expect(east).toEqual({ zp: 0, max: 0, wet: 0 });
    const across = sampleBox(f, 10.5, 79.5, 0.2)!; // half in it
    expect(across.wet).toBeGreaterThan(0.3);
    expect(across.wet).toBeLessThan(0.7);
    expect(sampleBox(f, 20, 79.5, 0.2)).toBeNull(); // off the frame
  });

  it('counts only echoes of RAIN_DBZ or more as wet', () => {
    expect(sampleBox(frame(byteFor(RAIN_DBZ - 5)), 10.5, 79.2, 0.1)!.wet).toBe(0);
  });

  it('samples the live picture and the nowcast 30 and 60 minutes ahead', () => {
    const live = frame(byteFor(40), 5000);
    const s = sampleAll(live, [{ ...frame(byteFor(30)), leadMin: 30 }, { ...frame(0), leadMin: 60 }], [[10.5, 79.2], [12, 79]], 0.1);
    expect(s.timeMs).toBe(5000);
    expect(s.live[0]!.wet).toBe(1);
    expect(s.live[1]).toBeNull();
    expect(s.n30[0]!.max).toBeCloseTo(byteToDbz(byteFor(30))!, 1);
    expect(s.n60[0]!.zp).toBe(0);
    expect(sampleAll(null, [], [[10.5, 79.2]], 0.1)).toEqual({ timeMs: null, live: [null], n30: [null], n60: [null] });
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
