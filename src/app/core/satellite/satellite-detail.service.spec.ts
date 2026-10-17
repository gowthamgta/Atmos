import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SATELLITE_WINDOW_LIMITS, SatelliteDetailService } from './satellite-detail.service';
import { SatelliteFrame, SatelliteService } from './satellite.service';
import { SATELLITE_BOUNDS, SATELLITE_HRV, SATELLITE_IR, isTwilightTime, productForTime } from './satellite.config';
import { WINDOW_LOSSLESS_MAX_PX, kmPerPixel } from './satellite-window';

// a phone: the whole-India picture is 3 km a pixel, so windows are worth fetching (a desktop's picture is as fine as the satellite)
const PHONE_LIMITS = { maxPx: 1280, globalKmPerPx: kmPerPixel(SATELLITE_BOUNDS, 1000) };

/** A stand-in for the whole-India loop: the frames it shows, whether it is on and still loading, and the two jobs the detail service borrows. */
class FakeSatelliteService {
  readonly frames = signal<SatelliteFrame[]>([]);
  readonly active = signal(true);
  readonly loading = signal(false);
  built = 0;
  readonly downloadUrl = vi.fn(async (url: string): Promise<Blob | null> => new Blob([url], { type: 'image/jpeg' }));
  readonly process = vi.fn(async () => ({ url: `blob:built-${++this.built}` }));
}

/** Five frames, 15 minutes apart, ending at `lastMs`, all of one product. */
function loop(lastMs: number, product = SATELLITE_HRV): SatelliteFrame[] {
  return Array.from({ length: 5 }, (_, i) => {
    const timeMs = lastMs - (4 - i) * 900_000;
    return { timeMs, product, url: `blob:main-${timeMs}` };
  });
}

const MIDDAY = Date.parse('2026-06-15T07:00:00Z'); // about 12:30 IST: HRV
const MIDNIGHT = Date.parse('2026-06-15T19:00:00Z'); // about 00:30 IST: infrared
/** A phone's map zoomed in on Tamil Nadu: a state-sized window (a JPEG) at 8.5, a small one (a PNG) at 10. */
const view = (lat = 11.2, lon = 78.4, zoom = 8.5) => ({ lat, lon, zoom, width: 412, height: 800 });

/** Lets the settle timer fire and every promise it started finish. */
async function settle(ms = 400): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe('SatelliteDetailService', () => {
  let sat: FakeSatelliteService;
  let detail: SatelliteDetailService;

  beforeEach(() => {
    vi.useFakeTimers();
    if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = () => undefined;
    TestBed.configureTestingModule({
      providers: [
        { provide: SatelliteService, useClass: FakeSatelliteService },
        { provide: SATELLITE_WINDOW_LIMITS, useValue: PHONE_LIMITS },
      ],
    });
    sat = TestBed.inject(SatelliteService) as unknown as FakeSatelliteService;
    detail = TestBed.inject(SatelliteDetailService);
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  /** Puts a loop on the map and the map in view, and waits for the window. */
  async function show(frames = loop(MIDDAY), at = view()): Promise<void> {
    sat.frames.set(frames);
    detail.setView(at);
    TestBed.tick();
    await settle();
  }

  it('fetches a closer window of the HRV for every frame and builds each with the box it covers', async () => {
    await show();
    const shown = detail.shown();
    expect(shown).not.toBeNull();
    expect(shown!.frames).toHaveLength(5);
    expect(shown!.frames.every(f => f !== null)).toBe(true);
    expect(shown!.times).toEqual(sat.frames().map(f => f.timeMs));

    const urls = sat.downloadUrl.mock.calls.map(c => new URL(c[0]));
    expect(urls).toHaveLength(5); // one picture per frame, nothing else by day
    const w = shown!.window;
    for (const u of urls) {
      expect(u.searchParams.get('layers')).toBe('msg_iodc:rgb_eview');
      expect(u.searchParams.get('bbox')).toBe(`${w.bounds.south},${w.bounds.west},${w.bounds.north},${w.bounds.east}`);
      expect(u.searchParams.get('width')).toBe(String(w.size.width));
      expect(u.searchParams.get('height')).toBe(String(w.size.height));
    }
    expect(sat.process).toHaveBeenCalledTimes(5);
    for (const call of sat.process.mock.calls as unknown as unknown[][]) {
      expect(call[1]).toBe(SATELLITE_HRV);
      expect(call[4]).toBe(w.bounds);
    }
    expect(detail.loading()).toBe(false);
  });

  it('asks for the satellite pixel, not a finer one: that only makes the service repeat pixels, and streaks', async () => {
    await show();
    const w = detail.shown()!.window;
    expect(w.kmPerPx).toBeGreaterThanOrEqual(1.2);
    expect(w.kmPerPx).toBeLessThanOrEqual(1.5);
  });

  it('asks for a state-sized window as a JPEG: a PNG of that size would be too big to be worth it', async () => {
    await show(loop(MIDDAY), view(11.2, 78.4, 7.5));
    const w = detail.shown()!.window;
    expect(w.size.width * w.size.height).toBeGreaterThan(WINDOW_LOSSLESS_MAX_PX);
    expect(sat.downloadUrl.mock.calls.length).toBe(5);
    expect(sat.downloadUrl.mock.calls.every(c => new URL(c[0]).searchParams.get('format') === 'image/jpeg')).toBe(true);
    expect((sat.process.mock.calls as unknown as unknown[][]).every(c => c[5] === false)).toBe(true);
  });

  it('asks for a deep-zoom window as a lossless PNG, which skips the JPEG deblocking in the worker', async () => {
    await show(loop(MIDDAY), view(11.7, 79, 10)); // a window of about 150 km
    const w = detail.shown()!.window;
    expect(w.size.width * w.size.height).toBeLessThanOrEqual(WINDOW_LOSSLESS_MAX_PX);
    expect(sat.downloadUrl.mock.calls.length).toBe(5);
    expect(sat.downloadUrl.mock.calls.every(c => new URL(c[0]).searchParams.get('format') === 'image/png')).toBe(true);
    expect((sat.process.mock.calls as unknown as unknown[][]).every(c => c[5] === true)).toBe(true);
  });

  it('keeps a state-sized window when the map zooms in on it, as it is already at the satellite pixel', async () => {
    await show(loop(MIDDAY), view(11.2, 78.4, 8.5));
    const first = detail.shown()!.window.id;
    const downloads = sat.downloadUrl.mock.calls.length;
    detail.setView(view(11.3, 78.5, 10));
    await settle();
    expect(detail.shown()!.window.id).toBe(first);
    expect(sat.downloadUrl.mock.calls.length).toBe(downloads);
  });

  it('falls back to the JPEG when the service cannot make the PNG', async () => {
    sat.downloadUrl.mockImplementation(async (url: string): Promise<Blob | null> =>
      new URL(url).searchParams.get('format') === 'image/png' ? null : new Blob([url], { type: 'image/jpeg' }),
    );
    await show(loop(MIDDAY), view(11.7, 79, 10));
    const shown = detail.shown();
    expect(shown).not.toBeNull();
    expect(shown!.frames.every(f => f !== null)).toBe(true);
    const formats = sat.downloadUrl.mock.calls.map(c => new URL(c[0]).searchParams.get('format'));
    expect(formats.filter(f => f === 'image/png')).toHaveLength(5);
    expect(formats.filter(f => f === 'image/jpeg')).toHaveLength(5);
    expect((sat.process.mock.calls as unknown as unknown[][]).every(c => c[5] === false)).toBe(true);
  });

  it('is quiet by night: the infrared has nothing finer to give than the whole-India picture', async () => {
    await show(loop(MIDNIGHT, SATELLITE_IR));
    expect(detail.shown()).toBeNull();
    expect(sat.downloadUrl).not.toHaveBeenCalled();
  });

  it('waits for the whole-India pictures before it fetches anything, then goes', async () => {
    sat.loading.set(true);
    await show();
    expect(detail.shown()).toBeNull();
    expect(sat.downloadUrl).not.toHaveBeenCalled();
    sat.loading.set(false);
    TestBed.tick();
    await settle();
    expect(detail.shown()).not.toBeNull();
    expect(sat.downloadUrl).toHaveBeenCalledTimes(5);
  });

  it('gives no window while the layer is off or the map is zoomed out', async () => {
    sat.active.set(false);
    await show();
    expect(detail.shown()).toBeNull();
    sat.active.set(true);
    detail.setView({ lat: 20, lon: 80, zoom: 4, width: 412, height: 800 });
    TestBed.tick();
    await settle();
    expect(detail.shown()).toBeNull();
    expect(sat.downloadUrl).not.toHaveBeenCalled();
  });

  it('fetches nothing more while the map moves about inside the window', async () => {
    await show();
    const first = detail.shown()!.window.id;
    const downloads = sat.downloadUrl.mock.calls.length;
    const builds = sat.process.mock.calls.length;
    detail.setView(view(11.25, 78.45));
    await settle();
    detail.setView(view(11.15, 78.35));
    await settle();
    expect(detail.shown()!.window.id).toBe(first);
    expect(sat.downloadUrl.mock.calls.length).toBe(downloads);
    expect(sat.process.mock.calls.length).toBe(builds);
  });

  it('fetches another window when the map goes somewhere else, and remembers the old one for the way back', async () => {
    await show();
    const first = detail.shown()!.window.id;
    detail.setView(view(16, 74)); // well out of the first window
    await settle();
    const second = detail.shown()!.window.id;
    expect(second).not.toBe(first);
    expect(sat.downloadUrl).toHaveBeenCalledTimes(10);

    detail.setView(view()); // back again: its pictures are still downloaded, only rebuilt
    await settle();
    expect(detail.shown()!.window.id).toBe(first);
    expect(sat.downloadUrl).toHaveBeenCalledTimes(10);
  });

  it('forgets the downloads of the window used longest ago once three others have been', async () => {
    await show();
    const places: [number, number][] = [[16, 74], [8, 90], [28, 78]];
    for (const [lat, lon] of places) {
      detail.setView(view(lat, lon));
      await settle();
    }
    expect(sat.downloadUrl).toHaveBeenCalledTimes(20); // four windows, five pictures each
    detail.setView(view()); // the first window's downloads were dropped: it is fetched again
    await settle();
    expect(sat.downloadUrl).toHaveBeenCalledTimes(25);
  });

  it('adds the infrared picture of a frame at dawn or dusk, at half the pixels, for the terminator blend', async () => {
    // a time in March when the sun is up over the middle of India (HRV) yet the terminator crosses the picture
    let twilight = 0;
    for (let min = 0; min < 24 * 60 && !twilight; min += 15) {
      const t = Date.parse('2026-03-21T00:00:00Z') + min * 60_000;
      if (productForTime(t).id === 'hrv' && isTwilightTime(t)) twilight = t;
    }
    expect(twilight).toBeGreaterThan(0);
    await show(loop(twilight));
    const shown = detail.shown()!;
    const urls = sat.downloadUrl.mock.calls.map(c => new URL(c[0]));
    const ir = urls.filter(u => u.searchParams.get('layers') === 'msg_iodc:ir108');
    const hrv = urls.filter(u => u.searchParams.get('layers') === 'msg_iodc:rgb_eview');
    expect(hrv.length).toBeGreaterThan(0);
    expect(ir.length).toBe(hrv.length);
    expect(Number(ir[0].searchParams.get('width'))).toBe(Math.round(shown.window.size.width / 2));
  });

  it('keeps a frame it could not build as null and tries it again the next time', async () => {
    let failures = 2; // the newest picture is built twice in the first refresh (alone, then with the loop): it fails both times
    sat.process.mockImplementation(async () => {
      if (failures > 0) {
        failures--;
        return null as unknown as { url: string };
      }
      return { url: `blob:built-${++sat.built}` };
    });
    await show();
    expect(detail.shown()!.frames.filter(f => f === null)).toHaveLength(1);
    detail.setView(view(11.25, 78.45));
    sat.frames.set(loop(MIDDAY)); // a refresh of the loop
    TestBed.tick();
    await settle();
    expect(detail.shown()!.frames.every(f => f !== null)).toBe(true);
  });

  it('lets go of the window when the layer is turned off', async () => {
    await show();
    expect(detail.shown()).not.toBeNull();
    sat.active.set(false);
    TestBed.tick();
    await settle();
    expect(detail.shown()).toBeNull();
  });
});
