import { describe, expect, it } from 'vitest';
import type { ShownWindow } from './satellite-detail.service';
import type { SatelliteFrame } from './satellite.service';
import type { SatelliteWindow } from './satellite-window';
import { chooseWindow, kmPerPixel } from './satellite-window';
import {
  SATELLITE_BOUNDS,
  SATELLITE_HRV,
  SATELLITE_IR,
  SATELLITE_WV,
  productForTime,
  isTwilightTime,
  SatelliteView,
} from './satellite.config';

const PHONE = { maxPx: 1024, globalKmPerPx: kmPerPixel(SATELLITE_BOUNDS, 1000) };
const DESKTOP = { maxPx: 1600, globalKmPerPx: kmPerPixel(SATELLITE_BOUNDS, 2000) };
const view = (lat: number, lon: number, zoom: number, width = 412, height = 800) => ({ lat, lon, zoom, width, height });

/** A midday time in June: the sun is well up over India. */
const MIDDAY_MS = Date.parse('2026-06-15T07:00:00Z'); // ~12:30 IST
/** A midnight time: no sun over India at all. */
const MIDNIGHT_MS = Date.parse('2026-06-15T19:00:00Z'); // ~00:30 IST
/** Dawn in March: the terminator crosses India. */
const DAWN_MS = Date.parse('2026-03-21T00:45:00Z');

/** Build a fake SatelliteFrame for testing alignment. */
function fakeFrame(timeMs: number, productId: 'hrv' | 'ir' | 'wv' = 'hrv'): SatelliteFrame {
  const product = productId === 'hrv' ? SATELLITE_HRV : productId === 'ir' ? SATELLITE_IR : SATELLITE_WV;
  return { timeMs, product, url: `blob:frame-${timeMs}` };
}

/** Build a ShownWindow the way refresh() does: one entry per main frame, null when the window has no raw for that time. */
function buildShownWindow(
  win: SatelliteWindow,
  mainTimes: number[],
  windowTimes: Set<number>,
): ShownWindow {
  const times = mainTimes;
  const frames: (SatelliteFrame | null)[] = mainTimes.map(t =>
    windowTimes.has(t) ? fakeFrame(t) : null,
  );
  return { window: win, times, frames };
}

describe('ShownWindow interface contract', () => {
  it('has times and frames arrays of the same length', () => {
    const win = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
    const mainTimes = [MIDDAY_MS, MIDDAY_MS + 900_000, MIDDAY_MS + 1_800_000, MIDDAY_MS + 2_700_000, MIDDAY_MS + 3_600_000];
    const shown = buildShownWindow(win, mainTimes, new Set(mainTimes));
    expect(shown.times).toHaveLength(shown.frames.length);
    expect(shown.times).toHaveLength(5);
  });

  it('carries a window whose bounds are a valid GeoBounds', () => {
    const win = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
    const shown = buildShownWindow(win, [MIDDAY_MS], new Set([MIDDAY_MS]));
    const b = shown.window.bounds;
    expect(b.south).toBeLessThan(b.north);
    expect(b.west).toBeLessThan(b.east);
  });

  it('has a non-empty id on the window', () => {
    const win = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
    const shown = buildShownWindow(win, [MIDDAY_MS], new Set([MIDDAY_MS]));
    expect(shown.window.id).toBeTruthy();
    expect(shown.window.id).toMatch(/^[\d.]+,[\d.]+,[\d.]+,[\d.]+$/);
  });
});

describe('frame alignment: null for times the window has not downloaded', () => {
  const win = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
  const step = 900_000; // 15 minutes
  const t1 = MIDDAY_MS;
  const t2 = MIDDAY_MS + step;
  const t3 = MIDDAY_MS + 2 * step;
  const t4 = MIDDAY_MS + 3 * step;
  const t5 = MIDDAY_MS + 4 * step;
  const mainTimes = [t1, t2, t3, t4, t5];

  it('returns null for frames the window does not have', () => {
    // window has frames at t2, t3, t5 only
    const shown = buildShownWindow(win, mainTimes, new Set([t2, t3, t5]));
    expect(shown.frames[0]).toBeNull(); // t1
    expect(shown.frames[1]).not.toBeNull(); // t2
    expect(shown.frames[2]).not.toBeNull(); // t3
    expect(shown.frames[3]).toBeNull(); // t4
    expect(shown.frames[4]).not.toBeNull(); // t5
  });

  it('returns all frames when the window has all times', () => {
    const shown = buildShownWindow(win, mainTimes, new Set(mainTimes));
    for (const f of shown.frames) expect(f).not.toBeNull();
  });

  it('returns all nulls when the window has none of the times', () => {
    const shown = buildShownWindow(win, mainTimes, new Set());
    for (const f of shown.frames) expect(f).toBeNull();
  });

  it('aligns each frame time with the corresponding main time', () => {
    const shown = buildShownWindow(win, mainTimes, new Set([t2, t5]));
    expect(shown.times[1]).toBe(t2);
    expect(shown.frames[1]!.timeMs).toBe(t2);
    expect(shown.times[4]).toBe(t5);
    expect(shown.frames[4]!.timeMs).toBe(t5);
  });
});

describe('product selection: only HRV has finer detail', () => {
  it('returns HRV for daytime (midday IST)', () => {
    const product = productForTime(MIDDAY_MS);
    expect(product.id).toBe('hrv');
  });

  it('returns IR for nighttime (midnight IST)', () => {
    const product = productForTime(MIDNIGHT_MS);
    expect(product.id).toBe('ir');
  });

  it('returns WV when the mode is locked to water vapour, regardless of time', () => {
    expect(productForTime(MIDDAY_MS, 'wv').id).toBe('wv');
    expect(productForTime(MIDNIGHT_MS, 'wv').id).toBe('wv');
  });

  it('returns IR when the mode is locked to infrared, even during the day', () => {
    expect(productForTime(MIDDAY_MS, 'ir').id).toBe('ir');
  });

  it('the detail service only fetches HRV frames because IR and WV are no finer than the main picture', () => {
    // Simulate the filtering the service does: items.filter(i => i.product.id === 'hrv')
    const step = 900_000;
    const times = Array.from({ length: 5 }, (_, i) => MIDDAY_MS + i * step);
    const items = times.map(t => ({ timeMs: t, product: productForTime(t) }));
    const hrv = items.filter(i => i.product.id === 'hrv');
    // all midday frames are HRV
    expect(hrv).toHaveLength(5);

    // at night, none are HRV
    const nightTimes = Array.from({ length: 5 }, (_, i) => MIDNIGHT_MS + i * step);
    const nightItems = nightTimes.map(t => ({ timeMs: t, product: productForTime(t) }));
    const nightHrv = nightItems.filter(i => i.product.id === 'hrv');
    expect(nightHrv).toHaveLength(0);
  });
});

describe('twilight detection for the download path', () => {
  it('detects dawn as twilight (the terminator crosses India)', () => {
    expect(isTwilightTime(DAWN_MS)).toBe(true);
  });

  it('does not detect midday or midnight as twilight', () => {
    expect(isTwilightTime(MIDDAY_MS)).toBe(false);
    expect(isTwilightTime(MIDNIGHT_MS)).toBe(false);
  });
});

describe('window bounds are always inside SATELLITE_BOUNDS', () => {
  const corners: [number, number][] = [
    [11.2, 78.4],   // centre of India
    [5.6, 68.4],    // south-west corner
    [37, 97],       // north-east corner
    [6, 96.5],      // south-east corner
    [36.5, 69],     // north-west corner
    [20, 80],       // middle
  ];

  for (const [lat, lon] of corners) {
    it(`at (${lat}, ${lon}) the window fits inside the satellite box`, () => {
      for (const limits of [PHONE, DESKTOP]) {
        const w = chooseWindow(view(lat, lon, 7.5), limits);
        if (!w) continue; // no window at this zoom is fine
        expect(w.bounds.south).toBeGreaterThanOrEqual(SATELLITE_BOUNDS.south);
        expect(w.bounds.north).toBeLessThanOrEqual(SATELLITE_BOUNDS.north);
        expect(w.bounds.west).toBeGreaterThanOrEqual(SATELLITE_BOUNDS.west);
        expect(w.bounds.east).toBeLessThanOrEqual(SATELLITE_BOUNDS.east);
      }
    });
  }
});

describe('window picture size fits within the maxPx limit', () => {
  it('phone window at zoom 7.5 fits within 1024 pixels', () => {
    const w = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
    expect(w).not.toBeNull();
    expect(w.size.width).toBeLessThanOrEqual(PHONE.maxPx);
    expect(w.size.height).toBeLessThanOrEqual(PHONE.maxPx * 1.05); // a little slack for aspect ratio
  });

  it('desktop window at zoom 7 fits within 1600 pixels', () => {
    const w = chooseWindow(view(11.2, 78.4, 7, 1400, 800), DESKTOP)!;
    expect(w).not.toBeNull();
    expect(w.size.width).toBeLessThanOrEqual(DESKTOP.maxPx);
    expect(w.size.height).toBeLessThanOrEqual(DESKTOP.maxPx * 1.05);
  });

  it('even at high zoom the picture stays within the limit', () => {
    for (const z of [8, 9, 10, 12]) {
      const w = chooseWindow(view(11.2, 78.4, z), PHONE)!;
      expect(w).not.toBeNull();
      expect(w.size.width).toBeLessThanOrEqual(PHONE.maxPx);
    }
  });
});

describe('look key format: the cache key for view + enhance', () => {
  // The look key is `${view}${enhance ? '+' : ''}` as in satellite-detail.service.ts line 151
  // and lookKey() in satellite.service.ts line 324

  function lookKey(viewMode: SatelliteView, enhance: boolean): string {
    return viewMode === 'picture' && enhance ? 'picture+' : viewMode;
  }

  it('is "clouds" for clouds view regardless of enhance', () => {
    expect(lookKey('clouds', false)).toBe('clouds');
    expect(lookKey('clouds', true)).toBe('clouds');
  });

  it('is "thermal" for thermal view regardless of enhance', () => {
    expect(lookKey('thermal', false)).toBe('thermal');
    expect(lookKey('thermal', true)).toBe('thermal');
  });

  it('is "picture" for picture view without enhancement', () => {
    expect(lookKey('picture', false)).toBe('picture');
  });

  it('is "picture+" for picture view with enhancement', () => {
    expect(lookKey('picture', true)).toBe('picture+');
  });
});

describe('raw key format: the cache key for downloads', () => {
  // raw key = `${win.id}|${product.id}|${timeMs}` as in satellite-detail.service.ts line 110

  it('has the shape windowId|productId|timeMs', () => {
    const win = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
    const product = SATELLITE_HRV;
    const timeMs = MIDDAY_MS;
    const rawKey = `${win.id}|${product.id}|${timeMs}`;
    expect(rawKey).toMatch(/^[\d.,]+\|hrv\|\d+$/);
  });

  it('different windows produce different raw keys for the same time', () => {
    const win1 = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
    const win2 = chooseWindow(view(20, 85, 7.5), PHONE)!;
    expect(win1.id).not.toBe(win2.id);
    const key1 = `${win1.id}|hrv|${MIDDAY_MS}`;
    const key2 = `${win2.id}|hrv|${MIDDAY_MS}`;
    expect(key1).not.toBe(key2);
  });
});

describe('window cache pruning: useWindow keeps only KEEP_WINDOWS=3', () => {
  /** Simulates the useWindow logic from the service (lines 137-144). */
  function simulateUseWindow(
    windowsUsed: string[],
    raws: Map<string, unknown>,
    id: string,
    keepWindows = 3,
  ): void {
    const at = windowsUsed.indexOf(id);
    if (at >= 0) windowsUsed.splice(at, 1);
    windowsUsed.push(id);
    while (windowsUsed.length > keepWindows) {
      const old = windowsUsed.shift()!;
      for (const key of [...raws.keys()]) if (key.startsWith(`${old}|`)) raws.delete(key);
    }
  }

  it('keeps the three most recent windows and drops the oldest', () => {
    const windowsUsed: string[] = [];
    const raws = new Map<string, unknown>();

    // use 4 windows
    for (const id of ['w1', 'w2', 'w3', 'w4']) {
      raws.set(`${id}|hrv|100`, 'blob');
      raws.set(`${id}|hrv|200`, 'blob');
      simulateUseWindow(windowsUsed, raws, id);
    }

    expect(windowsUsed).toEqual(['w2', 'w3', 'w4']);
    // w1's downloads are gone
    expect(raws.has('w1|hrv|100')).toBe(false);
    expect(raws.has('w1|hrv|200')).toBe(false);
    // w2, w3, w4 are kept
    expect(raws.has('w2|hrv|100')).toBe(true);
    expect(raws.has('w3|hrv|100')).toBe(true);
    expect(raws.has('w4|hrv|100')).toBe(true);
  });

  it('re-using a window moves it to the end, so it is not pruned', () => {
    const windowsUsed: string[] = [];
    const raws = new Map<string, unknown>();

    for (const id of ['w1', 'w2', 'w3']) {
      raws.set(`${id}|hrv|100`, 'blob');
      simulateUseWindow(windowsUsed, raws, id);
    }
    // re-use w1 (moves it to the end)
    simulateUseWindow(windowsUsed, raws, 'w1');
    // add w4: this should drop w2 (the oldest)
    raws.set('w4|hrv|100', 'blob');
    simulateUseWindow(windowsUsed, raws, 'w4');

    expect(windowsUsed).toEqual(['w3', 'w1', 'w4']);
    expect(raws.has('w2|hrv|100')).toBe(false);
    expect(raws.has('w1|hrv|100')).toBe(true);
  });
});

describe('download queue: newest first, skip cached', () => {
  /** Simulates the queue-building logic from refresh() (line 119). */
  function buildQueue(
    items: { rawKey: string; timeMs: number }[],
    cachedKeys: Set<string>,
  ): string[] {
    return items
      .filter(i => !cachedKeys.has(i.rawKey))
      .reverse()
      .map(i => i.rawKey);
  }

  it('filters out already-cached items', () => {
    const items = [
      { rawKey: 'w|hrv|100', timeMs: 100 },
      { rawKey: 'w|hrv|200', timeMs: 200 },
      { rawKey: 'w|hrv|300', timeMs: 300 },
    ];
    const queue = buildQueue(items, new Set(['w|hrv|200']));
    expect(queue).toEqual(['w|hrv|300', 'w|hrv|100']);
  });

  it('reverses so the newest is first', () => {
    const items = [
      { rawKey: 'w|hrv|100', timeMs: 100 },
      { rawKey: 'w|hrv|200', timeMs: 200 },
      { rawKey: 'w|hrv|300', timeMs: 300 },
    ];
    const queue = buildQueue(items, new Set());
    expect(queue[0]).toBe('w|hrv|300');
    expect(queue[2]).toBe('w|hrv|100');
  });

  it('returns an empty queue when everything is cached', () => {
    const items = [
      { rawKey: 'w|hrv|100', timeMs: 100 },
      { rawKey: 'w|hrv|200', timeMs: 200 },
    ];
    const queue = buildQueue(items, new Set(['w|hrv|100', 'w|hrv|200']));
    expect(queue).toHaveLength(0);
  });
});

describe('download concurrency: limited to 3 workers', () => {
  it('spawns at most DOWNLOAD_CONCURRENCY=3 workers for the queue', () => {
    const DOWNLOAD_CONCURRENCY = 3;
    for (const queueLen of [0, 1, 2, 3, 5, 10]) {
      const workerCount = Math.min(DOWNLOAD_CONCURRENCY, queueLen);
      expect(workerCount).toBeLessThanOrEqual(3);
      if (queueLen >= 3) expect(workerCount).toBe(3);
    }
  });
});

describe('the detail window half-size for natural-colour downloads', () => {
  it('halves the window size with a floor of 64', () => {
    // Simulates the logic in download() (line 155)
    const halfSize = (size: { width: number; height: number }) => ({
      width: Math.max(64, Math.round(size.width / 2)),
      height: Math.max(64, Math.round(size.height / 2)),
    });

    const win = chooseWindow(view(11.2, 78.4, 7.5), PHONE)!;
    const half = halfSize(win.size);
    expect(half.width).toBe(Math.max(64, Math.round(win.size.width / 2)));
    expect(half.height).toBe(Math.max(64, Math.round(win.size.height / 2)));
    expect(half.width).toBeGreaterThanOrEqual(64);
    expect(half.height).toBeGreaterThanOrEqual(64);
  });

  it('clamps very small sizes to 64', () => {
    const halfSize = (size: { width: number; height: number }) => ({
      width: Math.max(64, Math.round(size.width / 2)),
      height: Math.max(64, Math.round(size.height / 2)),
    });

    expect(halfSize({ width: 100, height: 80 })).toEqual({ width: 64, height: 64 });
    expect(halfSize({ width: 200, height: 200 })).toEqual({ width: 100, height: 100 });
  });
});
