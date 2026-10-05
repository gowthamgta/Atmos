import { Injectable, signal } from '@angular/core';

export type PanelId = 'layers' | 'about';

/** Which top-right panel is open. Only one at a time, so they never stack on top of each other. */
@Injectable({ providedIn: 'root' })
export class PanelService {
  readonly open = signal<PanelId | null>(null);

  toggle(id: PanelId): void {
    this.open.update(current => (current === id ? null : id));
  }

  close(id?: PanelId): void {
    if (!id || this.open() === id) this.open.set(null);
  }
}
