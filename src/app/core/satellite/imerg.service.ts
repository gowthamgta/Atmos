import { Injectable, computed, signal } from '@angular/core';
import { IMERG_HISTORY_H, IMERG_PROBE_TILE, IMERG_SLOT_MS, imergCandidates, imergLabelIst, imergTemplate, imergTileUrl } from './imerg';

/** State of the observed-rain layer: the half-hour picture shown, and the newest one that exists. */
@Injectable({ providedIn: 'root' })
export class ImergService {
  /** Start of the shown 30-minute slot (ms), or null before the newest one is found. */
  readonly slot = signal<number | null>(null);
  readonly newest = signal<number | null>(null);
  readonly opacity = signal(0.9);
  readonly checking = signal(false);
  readonly failed = signal(false);
  private token = 0;

  readonly template = computed(() => (this.slot() === null ? '' : imergTemplate(this.slot()!)));
  readonly label = computed(() => (this.slot() === null ? '' : imergLabelIst(this.slot()!)));
  readonly canGoBack = computed(() => this.slot() !== null && this.newest() !== null && this.slot()! - IMERG_SLOT_MS >= this.newest()! - IMERG_HISTORY_H * 3_600_000);
  readonly canGoForward = computed(() => this.slot() !== null && this.newest() !== null && this.slot()! < this.newest()!);

  /** Looks for the newest picture (the layer was just switched on, or it has been a while). */
  async pickNewest(): Promise<void> {
    const token = ++this.token;
    this.checking.set(true);
    this.failed.set(false);
    try {
      for (const slot of imergCandidates(Date.now())) {
        if (await this.exists(slot)) {
          if (token !== this.token) return;
          this.newest.set(slot);
          this.slot.set(slot);
          return;
        }
        if (token !== this.token) return;
      }
      this.failed.set(true);
    } finally {
      if (token === this.token) this.checking.set(false);
    }
  }

  /** Moves by `n` half hours (negative: earlier), within the history and not beyond the newest. */
  step(n: number): void {
    const slot = this.slot();
    const newest = this.newest();
    if (slot === null || newest === null) return;
    const next = Math.min(newest, Math.max(newest - IMERG_HISTORY_H * 3_600_000, slot + n * IMERG_SLOT_MS));
    this.slot.set(next);
  }

  private async exists(slot: number): Promise<boolean> {
    try {
      const { z, x, y } = IMERG_PROBE_TILE;
      return (await fetch(imergTileUrl(slot, z, x, y))).ok;
    } catch {
      return false;
    }
  }
}
