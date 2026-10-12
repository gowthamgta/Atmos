import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { FieldLoaderService } from '../forecast/field-loader.service';
import { MapHostService } from './map-host.service';
import { FrameStats, frameStats } from './perf-stats';

const KEY = 'atmosiq-perf-meter';
/** How much of the recent past the live figures are made from. */
const WINDOW_MS = 2000;
const REPORT_MS = 500;

export interface LiveFigures {
  stats: FrameStats | null;
  /** No frame has come for over a second: the page is hidden or the tab is in the background. */
  paused: boolean;
  /** Long tasks (over 50 ms on the page's main thread) in the last ten seconds, and their total time. */
  longTasks: number;
  longTaskMs: number;
  heapMB: number | null;
  /** What other parts of the app report (the number of wind streaks, pictures in memory). */
  probes: Record<string, string>;
}

export interface TestResult {
  /** The animation alone: the camera still, the wind streaks moving. */
  still: FrameStats | null;
  /** The camera panning and zooming over the animation. */
  moving: FrameStats | null;
  /** Describes the device and the page the figures are for. */
  device: string;
  /** When it ran. */
  at: number;
}

/**
 * How smoothly the map draws, on the device in the visitor's hands: a small meter of the frame rate and its worst frames (and long tasks and
 * memory), and a short test that pans and zooms the map for ten seconds and reports the same figures. Nothing runs unless the meter is on or
 * a test is under way, so it costs nothing when it is not wanted. (Frames only come while the page is on screen, so a test in a hidden tab
 * reports that it saw none.)
 */
@Injectable({ providedIn: 'root' })
export class PerfMeterService {
  private readonly loader = inject(FieldLoaderService);
  private readonly mapHost = inject(MapHostService);

  readonly enabled = signal(this.load());
  readonly live = signal<LiveFigures | null>(null);
  readonly testing = signal(false);
  readonly test = signal<TestResult | null>(null);

  private readonly probes = new Map<string, () => string>();
  private frames: { t: number; d: number }[] = [];
  private raf = 0;
  private last = 0;
  private lastReport = 0;
  private recorder: number[] | null = null;
  private longTasks: { t: number; d: number }[] = [];
  private observer: PerformanceObserver | null = null;

  constructor() {
    effect(() => {
      const on = this.enabled();
      try {
        localStorage.setItem(KEY, on ? '1' : '0');
      } catch {
        /* storage blocked: the choice lasts for this visit */
      }
      untracked(() => (on ? this.start() : this.stopIfIdle()));
    });
  }

  private load(): boolean {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  }

  /** Another part of the app offers a figure for the meter (the number of wind streaks, say). */
  probe(name: string, read: (() => string) | null): void {
    if (read) this.probes.set(name, read);
    else this.probes.delete(name);
  }

  toggle(): void {
    this.enabled.update(on => !on);
  }

  // ---- the frame loop ------------------------------------------------------------------------------------------------
  private start(): void {
    if (this.raf || typeof requestAnimationFrame !== 'function') return;
    this.last = 0;
    this.observeLongTasks();
    const tick = (now: number): void => {
      if (this.last) {
        const d = now - this.last;
        this.frames.push({ t: now, d });
        this.recorder?.push(d);
      }
      this.last = now;
      while (this.frames.length && now - this.frames[0].t > WINDOW_MS) this.frames.shift();
      if (now - this.lastReport >= REPORT_MS) {
        this.lastReport = now;
        this.report(now);
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    // with the page hidden no frame comes, so the figures say "paused" rather than keep the last ones
    this.pauseWatch = setInterval(() => {
      if (this.last && performance.now() - this.last > 1000) this.live.update(v => (v ? { ...v, paused: true } : v));
    }, 1000);
  }

  private pauseWatch: ReturnType<typeof setInterval> | null = null;

  private stopIfIdle(): void {
    if (this.enabled() || this.testing()) return;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.pauseWatch) clearInterval(this.pauseWatch);
    this.pauseWatch = null;
    this.observer?.disconnect();
    this.observer = null;
    this.frames = [];
    this.live.set(null);
  }

  private observeLongTasks(): void {
    if (this.observer || typeof PerformanceObserver === 'undefined') return;
    try {
      this.observer = new PerformanceObserver(list => {
        const now = performance.now();
        for (const e of list.getEntries()) this.longTasks.push({ t: now, d: e.duration });
        this.longTasks = this.longTasks.filter(x => now - x.t < 10_000);
      });
      this.observer.observe({ type: 'longtask', buffered: false });
    } catch {
      this.observer = null;           // a browser without long task timing: the figure stays at 0
    }
  }

  private report(now: number): void {
    const stats = frameStats(this.frames.map(f => f.d));
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    const recent = this.longTasks.filter(x => now - x.t < 10_000);
    const probes: Record<string, string> = { pictures: String(this.loader.cached) };
    for (const [name, read] of this.probes) {
      try {
        probes[name] = read();
      } catch {
        /* a probe of something that is gone */
      }
    }
    this.live.set({ stats, paused: false, longTasks: recent.length, longTaskMs: Math.round(recent.reduce((s, x) => s + x.d, 0)), heapMB: heap === undefined ? null : Math.round(heap / 1048576), probes });
  }

  // ---- the test --------------------------------------------------------------------------------------------------------
  /** Ten seconds: the animation alone for three, then the camera panning and zooming over it for seven. */
  async runTest(centre: { lat: number; lon: number; zoom: number }): Promise<void> {
    if (this.testing()) return;
    this.testing.set(true);
    this.start();
    try {
      const sample = async (work: () => Promise<void>): Promise<FrameStats | null> => {
        this.recorder = [];
        await work();
        const stats = frameStats(this.recorder);
        this.recorder = null;
        return stats;
      };
      const still = await sample(() => new Promise<void>(resolve => setTimeout(resolve, 3000)));
      const { lat, lon, zoom } = centre;
      const legs = [
        { lat: lat + 1.6, lon: lon + 2.2, zoom: zoom + 1 },
        { lat: lat - 1.2, lon: lon - 1.8, zoom: zoom + 0.4 },
        { lat, lon, zoom },
      ];
      const moving = await sample(() => this.mapHost.tour(legs, 2300));
      this.test.set({ still, moving, device: this.describeDevice(), at: Date.now() });
    } finally {
      this.testing.set(false);
      this.stopIfIdle();
    }
  }

  private describeDevice(): string {
    const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency} cores` : '';
    return [`${innerWidth}×${innerHeight} px at ×${ratio.toFixed(2).replace(/\.?0+$/, '')}`, cores, this.mapHost.renderer()].filter(Boolean).join(' · ');
  }
}
