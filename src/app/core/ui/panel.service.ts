import { Injectable, signal } from '@angular/core';

/** The panels that open over the map: the menu (top right), the model list (above the model button), the altitude list (above the airplane button) and the about box. */
export type PanelId = 'menu' | 'models' | 'altitude' | 'about';
/** The tabs of the menu: the layers with the overlays and the altitude, the forecast models, and the settings. */
export type MenuTab = 'layers' | 'models' | 'settings';

/** Which panel is open. Only one at a time, so they never stack on top of each other. */
@Injectable({ providedIn: 'root' })
export class PanelService {
  readonly open = signal<PanelId | null>(null);
  /** The tab the menu opens on (it remembers the last one used while the page is open). */
  readonly menuTab = signal<MenuTab>('layers');

  toggle(id: PanelId): void {
    this.open.update(current => (current === id ? null : id));
  }

  /** Opens the menu on a tab (or closes it when that tab is already showing). */
  showTab(tab: MenuTab): void {
    if (this.open() === 'menu' && this.menuTab() === tab) {
      this.open.set(null);
      return;
    }
    this.menuTab.set(tab);
    this.open.set('menu');
  }

  close(id?: PanelId): void {
    if (!id || this.open() === id) this.open.set(null);
  }
}
