import { Injectable, inject, signal } from '@angular/core';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { ForecastStateService } from '../forecast/forecast-state.service';
import { RELIEF_CHOICE_KEY, WEAK_FPS, WEAK_PIXEL_RATIO, weakHardware } from './device-profile';

/**
 * Lighter drawing on a device that cannot keep up (the owner, 3 Nov 2026: "if a system is not capable then turn off terrain relief"). Weak
 * when the browser says so (weakHardware: 2 cores or fewer, 2 GB or less, a software GPU) or when the map, once loaded, draws under WEAK_FPS
 * frames a second over a few seconds. Then the 90 m terrain relief is turned off (unless the visitor has chosen it in the layer menu) and the
 * map is drawn at WEAK_PIXEL_RATIO at most. Checked once a visit.
 */
@Injectable({ providedIn: 'root' })
export class LowPowerService {
  private readonly state = inject(ForecastStateService);
  /** The device was found weak (lighter drawing in use). */
  readonly lowPower = signal(false);
  private checked = false;

  /** Called once the map has loaded. */
  check(map: MapLibreMap): void {
    if (this.checked || typeof window === 'undefined') return;
    this.checked = true;
    if (weakHardware()) {
      this.apply(map);
      return;
    }
    // the frame rate over a few seconds once the first pictures are in (the first frames, building the map, are left out)
    setTimeout(() => this.measureFps(fps => {
      if (fps < WEAK_FPS) this.apply(map);
    }), 3000);
  }

  private measureFps(done: (fps: number) => void, forMs = 4000): void {
    if (document.visibilityState !== 'visible') return; // a hidden tab draws no frames: nothing to judge by
    const gaps: number[] = [];
    let last = 0;
    const start = performance.now();
    const tick = (now: number) => {
      if (last) gaps.push(now - last);
      last = now;
      if (now - start < forMs) requestAnimationFrame(tick);
      else if (gaps.length > 10) {
        gaps.sort((a, b) => a - b);
        done(1000 / gaps[Math.floor(gaps.length / 2)]);
      }
    };
    requestAnimationFrame(tick);
  }

  private apply(map: MapLibreMap): void {
    this.lowPower.set(true);
    let chosen: string | null = null;
    try {
      chosen = localStorage.getItem(RELIEF_CHOICE_KEY);
    } catch {
      // no storage: no choice remembered
    }
    if (chosen === null) this.state.relief.set(false);
    const dpr = window.devicePixelRatio || 1;
    if (map.getPixelRatio() > WEAK_PIXEL_RATIO) map.setPixelRatio(Math.min(dpr, WEAK_PIXEL_RATIO));
  }
}
