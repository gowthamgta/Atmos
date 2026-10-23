import { Injectable, signal } from '@angular/core';
import { OWN_SATELLITES, OwnIndex } from './own-products';
import type { GeoBounds } from './satellite.config';

/** How often the newest frame is looked for while the radar is on (the satellite workflow publishes every 15 minutes). */
const REFRESH_MS = 5 * 60_000;

export interface SatelliteRainData {
  /** The newest Meteosat frame's data pack (measured cloud-top temperatures). */
  url: string;
  bounds: GeoBounds;
  minK: number;
  spanK: number;
  timeMs: number;
}

/** The newest Meteosat data pack for the rain estimate drawn where no radar sees (rendering/satellite-rain.layer.ts). */
@Injectable({ providedIn: 'root' })
export class SatelliteRainService {
  readonly latest = signal<SatelliteRainData | null>(null);
  private timer: ReturnType<typeof setInterval> | null = null;

  activate(): void {
    if (this.timer !== null) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  deactivate(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async refresh(): Promise<void> {
    try {
      const base = OWN_SATELLITES.msg.base;
      const res = await fetch(base + 'index.json', { cache: 'no-cache' });
      if (!res.ok) return;
      const index = (await res.json()) as OwnIndex;
      const f = [...index.frames].reverse().find(fr => fr.files.data);
      if (!f) return;
      const url = base + f.files.data!;
      if (this.latest()?.url === url) return;
      this.latest.set({ url, bounds: index.bounds, minK: index.data.minK, spanK: index.data.spanK, timeMs: Date.parse(f.time) });
    } catch {
      // the next refresh tries again
    }
  }
}
