import { Injectable, signal, computed } from '@angular/core';

export type BasemapType = 'dark';

export interface LayerConfig {
  id: string;
  name: string;
  active: boolean;
  opacity: number;
}

/**
 * Which "classic" map layer is shown: the IMD radar, the Meteosat satellite or the high-detail daily satellite picture; every forecast layer is handled by
 * ForecastStateService, which switches the radar off when a forecast layer is turned on (and the reverse).
 */
@Injectable({ providedIn: 'root' })
export class MapLayerService {
  readonly activeBasemap = signal<BasemapType>('dark');

  readonly layers = signal<LayerConfig[]>([
    { id: 'radar', name: 'IMD radar', active: false, opacity: 1.0 },
    { id: 'satellite', name: 'Meteosat satellite', active: false, opacity: 0.9 },
    { id: 'gibs', name: 'HD satellite', active: false, opacity: 1.0 },
  ]);

  readonly activeLayers = computed(() => this.layers().filter(l => l.active));

  /** Turn every classic layer (radar, satellites) off. */
  deactivateAll(): void {
    this.layers.update(layers => layers.map(l => ({ ...l, active: false })));
  }

  /** Show only this layer. */
  selectSingleLayer(id: string): void {
    this.layers.update(layers => layers.map(l => ({ ...l, active: l.id === id })));
  }

  setLayerOpacity(id: string, opacity: number): void {
    this.layers.update(layers => layers.map(l => (l.id === id ? { ...l, opacity } : l)));
  }
}
