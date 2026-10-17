import { Injectable, computed, signal } from '@angular/core';
import { MetarRecord, MetarFile, Nearest, RainGauge, RainSummary, SynopFile, SynopRecord, lastObservationSlot, latestPerStation, latestReports, latestStationReports, msToNextObservationSlot, nearestAirport, nearestGauge, nearestStation } from './observations';

const BASE = '/data/observations';
/** The airports and the weather stations are asked for live (Netlify functions that fetch and decode them); the committed files are the fallback. */
const LIVE = '/.netlify/functions';

interface Loaded {
  rain: RainSummary | null;
  airports: MetarRecord[];
  stations: SynopRecord[];
  markers: SynopRecord[];
  at: number;
}

/**
 * The weather stations (SYNOP) and the airports (METAR) are asked for at 32 minutes past every hour, while the app is open (and on first use);
 * the rain gauges still come from the file the observations workflow commits. If a live answer does not come, the committed file is used.
 */
@Injectable({ providedIn: 'root' })
export class ObservationsService {
  private readonly data = signal<Loaded | null>(null);
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** The newest report of every weather station (the map markers). Empty until the files have loaded. */
  readonly markers = computed(() => this.data()?.markers ?? []);

  /** Loads the observations now if they are missing or from before the last :32. */
  refresh(): Promise<void> {
    return this.ensureLoaded();
  }

  /** Observed rain and airport weather around a point. Starts loading the files on first use; empty until they arrive. */
  near(lat: number, lon: number): { gauge: Nearest<RainGauge> | null; airport: Nearest<MetarRecord> | null; station: Nearest<SynopRecord> | null; rainDate: string | null; rainWindow: string | null } | null {
    void this.ensureLoaded();
    const d = this.data();
    if (!d) return null;
    return {
      gauge: d.rain ? nearestGauge(d.rain.stations, lat, lon) : null,
      airport: nearestAirport(d.airports, lat, lon),
      station: nearestStation(d.stations, lat, lon),
      rainDate: d.rain?.date ?? null,
      rainWindow: d.rain?.window ?? null,
    };
  }

  private ensureLoaded(): Promise<void> {
    const d = this.data();
    if (d && d.at >= lastObservationSlot(Date.now())) {
      this.scheduleNext();
      return Promise.resolve();
    }
    this.inflight ??= this.load().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async load(): Promise<void> {
    const [rain, metar, synop] = await Promise.all([
      this.json<RainSummary>(`${BASE}/rain/latest.json`),
      this.live<MetarFile>('metar', `${BASE}/metar/latest.json`),
      this.live<SynopFile>('synop', `${BASE}/synop/latest.json`),
    ]);
    // a file that could not be read leaves the other source working; both missing leaves the card without an observed section
    this.data.set({ rain, airports: metar ? latestReports(metar) : [], stations: synop ? latestStationReports(synop) : [], markers: synop ? latestPerStation(synop) : [], at: Date.now() });
    this.scheduleNext();
  }

  /** Asks again at the next :32, as long as the app stays open. */
  private scheduleNext(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.ensureLoaded();
    }, msToNextObservationSlot(Date.now()) + 1000);
  }

  /** A live answer from the function, or the committed file when there is none (the function is not there on the dev server). */
  private async live<T extends { stations: unknown }>(name: string, fallback: string): Promise<T | null> {
    // the slot in the address gives every :32 its own copy at the edge, so the answer is never one cached before it
    const live = await this.json<T>(`${LIVE}/${name}?slot=${lastObservationSlot(Date.now())}`);
    return live && Object.keys(live.stations as object).length > 0 ? live : this.json<T>(fallback);
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
