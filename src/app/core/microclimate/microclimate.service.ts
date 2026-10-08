import { Injectable, signal } from '@angular/core';
import { PAGES } from '../forecast/forecast-models';
import { MicroMetric, MicroclimateData } from './microclimate.model';

export const MICROCLIMATE_URL = `${PAGES}/microclimate/tn.json`;

/** Loads the Tamil Nadu district microclimate once, the first time the card is opened. */
@Injectable({ providedIn: 'root' })
export class MicroclimateService {
  readonly data = signal<MicroclimateData | null>(null);
  readonly failed = signal(false);
  /** Show the chosen microclimate field on the map (a 1 km terrain-adjusted layer). */
  readonly onMap = signal(false);
  readonly metric = signal<MicroMetric>('feels');
  /** The district shown in the card (set from the picker or a click on the map). */
  readonly selected = signal('Chennai');
  private loading: Promise<void> | null = null;

  load(): void {
    if (this.data() || this.loading) return;
    this.failed.set(false);
    this.loading = fetch(MICROCLIMATE_URL, { cache: 'no-cache' })
      .then(res => {
        if (!res.ok) throw new Error(`${res.status} ${res.url}`);
        return res.json() as Promise<MicroclimateData>;
      })
      .then(json => this.data.set(json))
      .catch(err => {
        console.warn('[microclimate] unavailable', err);
        this.failed.set(true);
      })
      .finally(() => (this.loading = null));
  }
}
