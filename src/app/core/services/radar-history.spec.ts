import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { animationFile, gifFrameTimestamps, historySlots, parseIstStamp, recentFrames, scanForSlot } from './radar-history';

const T = (ist: string) => Date.parse(`${ist}+05:30`);

/** A minimal GIF: header, no global table, then per frame a comment and a 1x1 image. */
function tinyGif(stamps: (string | null)[]): Uint8Array {
  const b: number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x00, 0, 0];
  for (const s of stamps) {
    b.push(0x21, 0xf9, 4, 0, 0x32, 0, 0, 0); // graphic control
    if (s) {
      b.push(0x21, 0xfe, s.length, ...[...s].map(c => c.charCodeAt(0)), 0);
    }
    b.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x80); // image descriptor with a 2-entry local colour table
    b.push(0, 0, 0, 255, 255, 255);
    b.push(2, 2, 0x4c, 0x01, 0); // LZW data
  }
  b.push(0x3b);
  return new Uint8Array(b);
}

describe('animation frames', () => {
  it('names the IMD animation file for the products that have one', () => {
    expect(animationFile('kkl', 'caz')).toBe('animation/Converted/KKL_MAXZ.gif');
    expect(animationFile('tvm', 'sri')).toBe('animation/Converted/TVM_SRI.gif');
    expect(animationFile('kkl', 'ppi')).toBeNull();
  });

  it('reads IMD times as IST', () => {
    expect(parseIstStamp('2026-10-05T12:32:23')).toBe(Date.parse('2026-10-05T07:02:23Z'));
    expect(parseIstStamp('nothing')).toBeNull();
  });

  it('reads one time per frame from the GIF comments, null where a frame has none', () => {
    const times = gifFrameTimestamps(tinyGif(['2026-10-05T12:22:22', null, '2026-10-05T12:32:23']));
    expect(times).toEqual([T('2026-10-05T12:22:22'), null, T('2026-10-05T12:32:23')]);
    expect(gifFrameTimestamps(new Uint8Array([1, 2, 3]))).toEqual([]);
  });

  it('reads a real IMD animation when one is available locally', () => {
    const path = `${process.env['TEMP'] ?? ''}/kkl_anim.gif`;
    if (!existsSync(path)) return;
    const times = gifFrameTimestamps(new Uint8Array(readFileSync(path)));
    expect(times.length).toBeGreaterThan(5);
    expect(times.every(t => t !== null)).toBe(true);
  });

  it('keeps the last frame of each distinct scan in the last hour, oldest first', () => {
    const times = [T('2026-10-05T10:12:38'), T('2026-10-05T12:22:22'), T('2026-10-05T12:32:23'), T('2026-10-05T12:32:23'), null];
    expect(recentFrames(times)).toEqual([
      { index: 1, timeMs: T('2026-10-05T12:22:22') },
      { index: 3, timeMs: T('2026-10-05T12:32:23') },
    ]);
    expect(recentFrames([null, null])).toEqual([]);
  });
});

describe('loop steps', () => {
  it('covers the hour in 10-minute steps ending on the newest scan', () => {
    const slots = historySlots(T('2026-10-05T12:32:00'));
    expect(slots).toHaveLength(7);
    expect(slots.at(-1)).toBe(T('2026-10-05T12:32:00'));
    expect(slots[0]).toBe(T('2026-10-05T11:32:00'));
  });

  it('uses each radar\'s newest scan that is not after the step and not too old', () => {
    const scans = [{ timeMs: T('2026-10-05T12:02:00') }, { timeMs: T('2026-10-05T12:12:00') }, { timeMs: T('2026-10-05T12:22:00') }];
    expect(scanForSlot(scans, T('2026-10-05T12:15:00'))?.timeMs).toBe(T('2026-10-05T12:12:00'));
    expect(scanForSlot(scans, T('2026-10-05T12:50:00'))).toBeNull(); // newest is 28 min older: radar was down
    expect(scanForSlot(scans, T('2026-10-05T11:55:00'))).toBeNull();
  });
});
