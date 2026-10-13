import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessedRadarResult } from '../domain/models/radar.model';
import { NowcastFrame, RadarHistoryFrame, RadarService } from './radar.service';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 13, 5, 0);

function frame(timeMs: number, tag = 1): RadarHistoryFrame {
  return { field: new Uint8Array(16).fill(tag), width: 4, height: 4, coordinates: [[76, 9], [77, 9], [77, 8], [76, 8]], timeMs, track: new Float32Array(4) };
}
function guess(leadMin: number, tag = 9): NowcastFrame {
  return { field: new Uint8Array(4).fill(tag), width: 2, height: 2, coordinates: [[76, 9], [77, 9], [77, 8], [76, 8]], timeMs: T0 + leadMin * MIN, leadMin };
}
function mosaic(timeMs: number, tag = 1): ProcessedRadarResult {
  return {
    stationId: 'composite-mosaic',
    dataUrl: '',
    displayField: new Uint8Array(100).fill(tag),
    fieldData: { field: new Float32Array(100), cropW: 10, cropH: 10, cx: 5, cy: 5, radius: 5, bounds: [[8, 76], [9, 77]] },
    timing: { ist: '', utc: '', date: '', epochMs: timeMs },
    coordinates: [[76, 9], [77, 9], [77, 8], [76, 8]],
    isDisplayed: true,
  };
}

/** The radar service with no network: every request fails at once, so only what the test puts in is there. */
function service(): RadarService {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  const svc = TestBed.runInInjectionContext(() => new RadarService());
  svc.hideFaintFar.set(false);
  return svc;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 5 * MIN);                                  // five minutes after the live picture: it is recent enough to show
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the strip of the last hour, the live picture and the nowcast', () => {
  it('numbers the pictures from the oldest to the last step ahead, with the live picture in between', () => {
    const svc = service();
    svc.history.set([frame(T0 - 30 * MIN), frame(T0 - 20 * MIN), frame(T0 - 10 * MIN)]);
    svc.nowcast.set([guess(10), guess(20)]);
    expect(svc.cursorMax()).toBe(5);
    expect(svc.cursor()).toBe(3);                                   // the live picture, after the three of the loop

    svc.setCursor(0);
    expect([svc.playIndex(), svc.leadIndex(), svc.cursor()]).toEqual([0, null, 0]);
    svc.setCursor(3);
    expect([svc.playIndex(), svc.leadIndex(), svc.cursor()]).toEqual([null, null, 3]);
    svc.setCursor(4);
    expect([svc.playIndex(), svc.leadIndex(), svc.cursor()]).toEqual([null, 0, 4]);
    svc.setCursor(5);
    expect([svc.playIndex(), svc.leadIndex(), svc.cursor()]).toEqual([null, 1, 5]);
    svc.setCursor(99);
    expect(svc.cursor()).toBe(5);
    svc.setCursor(-4);
    expect(svc.cursor()).toBe(0);
  });

  it('shows the picture the clock is at: a step of the nowcast, a loop frame, or the live picture', () => {
    const svc = service();
    svc.compositeMosaic.set(mosaic(T0, 7));
    svc.history.set([frame(T0 - 20 * MIN, 2), frame(T0 - 10 * MIN, 3)]);
    svc.nowcast.set([guess(10, 9), guess(20, 8)]);
    expect(svc.displayed()?.field[0]).toBe(7);                      // live
    svc.setCursor(0);
    expect(svc.displayed()?.field[0]).toBe(2);
    svc.setCursor(3);
    expect(svc.displayed()?.field[0]).toBe(9);
    expect(svc.displayed()?.timeMs).toBe(T0 + 10 * MIN);
    svc.setCursor(4);
    expect(svc.displayed()?.field[0]).toBe(8);
  });

  it('leaves the nowcast when a loop frame is chosen, and the loop when a step ahead is', () => {
    const svc = service();
    svc.history.set([frame(T0 - 10 * MIN)]);
    svc.nowcast.set([guess(10)]);
    svc.setCursor(2);
    expect(svc.leadIndex()).toBe(0);
    svc.setPlayIndex(0);
    expect([svc.playIndex(), svc.leadIndex()]).toEqual([0, null]);
    svc.setCursor(2);
    expect([svc.playIndex(), svc.leadIndex()]).toEqual([null, 0]);
    svc.setPlayIndex(null);
    expect([svc.playIndex(), svc.leadIndex()]).toEqual([null, null]);
  });

  it('forgets the nowcast along with the loop when the product changes', () => {
    const svc = service();
    svc.history.set([frame(T0 - 10 * MIN)]);
    svc.nowcast.set([guess(10)]);
    svc.setCursor(2);
    svc.clearHistory();
    expect(svc.history()).toEqual([]);
    expect(svc.nowcast()).toEqual([]);
    expect([svc.playIndex(), svc.leadIndex(), svc.cursorMax()]).toEqual([null, null, 0]);
  });

  it('plays the whole strip from the oldest picture to the last guess, holds there, and starts again', async () => {
    const svc = service();
    svc.history.set([frame(T0 - 20 * MIN), frame(T0 - 10 * MIN)]);
    svc.nowcast.set([guess(10), guess(20)]);
    await svc.togglePlay();                                         // from the live picture it starts at the beginning
    const seen = [svc.cursor()];
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(700);
      seen.push(svc.cursor());
    }
    svc.pause();
    expect(seen).toEqual([0, 1, 2, 3, 4, 4, 0, 1, 2]);              // 0 to 4, held on the last guess for one more tick, then round again
    expect(svc.playing()).toBe(false);
  });

  it('does not play with fewer than two loop frames', async () => {
    const svc = service();
    svc.history.set([frame(T0 - 10 * MIN)]);
    svc.nowcast.set([guess(10)]);
    await svc.togglePlay();
    expect(svc.playing()).toBe(false);
  });
});

describe('the last hour keeping up as each live picture arrives', () => {
  const roll = (svc: RadarService) => (svc as unknown as { rollHistory(): void }).rollHistory();

  it('puts the picture that was live into the loop when the next one arrives', () => {
    const svc = service();
    svc.history.set([frame(T0 - 50 * MIN), frame(T0 - 40 * MIN), frame(T0 - 30 * MIN), frame(T0 - 20 * MIN), frame(T0 - 10 * MIN)]);
    svc.compositeMosaic.set(mosaic(T0, 5));
    roll(svc);                                                      // the first picture only has to be remembered
    expect(svc.history()).toHaveLength(5);
    svc.compositeMosaic.set(mosaic(T0 + 12 * MIN, 6));
    roll(svc);
    const h = svc.history();
    expect(h).toHaveLength(6);
    expect(h[5].timeMs).toBe(T0);
    expect(h[5].field[0]).toBe(5);                                  // the picture that had been live
    expect(h[5].track.length).toBeGreaterThan(0);
  });

  it('drops what is more than 70 minutes behind the newest picture, and moves the chosen frame along with the others', () => {
    const svc = service();
    svc.history.set([frame(T0 - 70 * MIN), frame(T0 - 60 * MIN), frame(T0 - 50 * MIN), frame(T0 - 10 * MIN)]);
    svc.setPlayIndex(2);                                            // the frame of T0 - 50 min
    svc.compositeMosaic.set(mosaic(T0, 5));
    roll(svc);
    svc.compositeMosaic.set(mosaic(T0 + 15 * MIN, 6));
    roll(svc);                                                      // T0 joins; T0 - 70 min is now 85 minutes old and goes, T0 - 60 min (75 minutes) too
    expect(svc.history().map(f => f.timeMs)).toEqual([T0 - 50 * MIN, T0 - 10 * MIN, T0]);
    expect(svc.history()[svc.playIndex()!].timeMs).toBe(T0 - 50 * MIN);   // still the same picture on the map
  });

  it('adds nothing while the loop is empty, or when the new picture is not newer, or too close to the last frame', () => {
    const svc = service();
    svc.compositeMosaic.set(mosaic(T0, 5));
    roll(svc);
    svc.compositeMosaic.set(mosaic(T0 + 10 * MIN, 6));
    roll(svc);
    expect(svc.history()).toEqual([]);

    svc.history.set([frame(T0 + 8 * MIN)]);                         // the last loop frame is 2 minutes before the picture that would join
    svc.compositeMosaic.set(mosaic(T0 + 20 * MIN, 7));
    roll(svc);
    expect(svc.history()).toHaveLength(1);
  });
});
