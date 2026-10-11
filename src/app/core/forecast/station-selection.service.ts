import { Injectable, signal } from '@angular/core';
import { SynopRecord } from './observations';

/** The weather station whose readings the station card shows (null when none is open). */
@Injectable({ providedIn: 'root' })
export class StationSelectionService {
  readonly selected = signal<SynopRecord | null>(null);

  select(record: SynopRecord): void {
    this.selected.set(record);
  }

  close(): void {
    this.selected.set(null);
  }
}
