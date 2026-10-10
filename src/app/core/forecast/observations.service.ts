import { Injectable, signal } from '@angular/core';
import { MetarRecord, MetarFile, Nearest, RainGauge, RainSummary, latestReports, nearestAirport, nearestGauge } from './observations';

const BASE = '/data/observations';
const REFRESH_MS = 30 * 60 * 1000;

interface Loaded {
  rain: RainSummary | null;
  airports: MetarRecord[];
  at: number;
}

/** Loads the observation files that the observations workflow commits (twice a day), once, and again after half an hour. */
@Injectable({ providedIn: 'root' })
export class ObservationsService {
  private readonly data = signal<Loaded | null>(null);
  private inflight: Promise<void> | null = null;

  /** Observed rain and airport weather around a point. Starts loading the files on first use; empty until they arrive. */
  near(lat: number, lon: number): { gauge: Nearest<RainGauge> | null; airport: Nearest<MetarRecord> | null; rainDate: string | null; rainWindow: string | null } | null {
    void this.ensureLoaded();
    const d = this.data();
    if (!d) return null;
    return {
      gauge: d.rain ? nearestGauge(d.rain.stations, lat, lon) : null,
      airport: nearestAirport(d.airports, lat, lon),
      rainDate: d.rain?.date ?? null,
      rainWindow: d.rain?.window ?? null,
    };
  }

  private ensureLoaded(): Promise<void> {
    const d = this.data();
    if (d && Date.now() - d.at < REFRESH_MS) return Promise.resolve();
    this.inflight ??= this.load().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async load(): Promise<void> {
    const [rain, metar] = await Promise.all([this.json<RainSummary>(`${BASE}/rain/latest.json`), this.json<MetarFile>(`${BASE}/metar/latest.json`)]);
    // a file that could not be read leaves the other source working; both missing leaves the card without an observed section
    this.data.set({ rain, airports: metar ? latestReports(metar) : [], at: Date.now() });
  }

  private async json<T>(url: string): Promise<T | null> {
    try {
      const res = await fetch(url);
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }
}
