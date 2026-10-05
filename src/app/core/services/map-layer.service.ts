import { Injectable, signal, computed } from '@angular/core';

export type BasemapType = 'dark';

export interface LayerConfig {
  id: string;
  name: string;
  icon: string;
  active: boolean;
  opacity: number;
}

@Injectable({ providedIn: 'root' })
export class MapLayerService {
  // Basemap selection: Dark Map with Terrain Shading
  readonly activeBasemap = signal<BasemapType>('dark');

  setBasemap(type: BasemapType): void {
    this.activeBasemap.set(type);
  }

  // Core atmospheric visualization layers - Strictly exclusive single-layer selection
  readonly layers = signal<LayerConfig[]>([
    {
      id: 'radar',
      name: 'Weather Radar (IMD)',
      icon: '📡',
      active: true,
      opacity: 1.0
    },
    {
      id: 'temp-500m',
      name: 'Temperature (Tamil Nadu)',
      icon: '🌡️',
      active: false,
      opacity: 0.85
    },
    {
      id: 'humidity-500m',
      name: 'Humidity (Tamil Nadu)',
      icon: '💧',
      active: false,
      opacity: 0.85
    },
    {
      id: 'wind-500m',
      name: 'Wind Streamlines (Tamil Nadu)',
      icon: '🍃',
      active: false,
      opacity: 0.90
    },
    {
      id: 'rain-24h',
      name: '24h Extreme Rain (ECMWF)',
      icon: '🌧️',
      active: false,
      opacity: 0.85
    },
    {
      id: 'cape',
      name: 'CAPE / Storm Index (ECMWF)',
      icon: '⚡',
      active: false,
      opacity: 0.85
    }
  ]);

  readonly activeLayers = computed(() =>
    this.layers().filter(l => l.active)
  );

  readonly activeLayerCount = computed(() =>
    this.activeLayers().length
  );

  toggleLayer(id: string): void {
    this.layers.update(layers => {
      const current = layers.find(l => l.id === id);
      const willBeActive = !current?.active;
      // Switching off an overlay falls back to radar rather than leaving an empty map
      const fallbackToRadar = !willBeActive && id !== 'radar';
      return layers.map(l => ({
        ...l,
        active: l.id === id ? willBeActive : (fallbackToRadar && l.id === 'radar')
      }));
    });
  }

  /** Turn every map layer off (radar and the legacy overlays). */
  deactivateAll(): void {
    this.layers.update(layers => layers.map(l => ({ ...l, active: false })));
  }

  selectSingleLayer(id: string): void {
    this.layers.update(layers =>
      layers.map(l => ({
        ...l,
        active: l.id === id
      }))
    );
  }

  setLayerActive(id: string, active: boolean): void {
    this.layers.update(layers =>
      layers.map(l => {
        if (active) {
          return { ...l, active: l.id === id };
        } else {
          return l.id === id ? { ...l, active: false } : l;
        }
      })
    );
  }

  setLayerOpacity(id: string, opacity: number): void {
    this.layers.update(layers =>
      layers.map(l => l.id === id ? { ...l, opacity } : l)
    );
  }

  // Real-time Wind Streamline Speed Adjustment
  readonly windSpeedMultiplier = signal<number>(1.0);

  // 500-meter regional downscaling resolution
  readonly downscaleResolutionMeters = signal<number>(500);

  setWindSpeedMultiplier(speed: number): void {
    this.windSpeedMultiplier.set(Math.max(0.2, Math.min(3.5, Math.round(speed * 10) / 10)));
  }

  setDownscaleResolution(meters: number): void {
    this.downscaleResolutionMeters.set(meters);
  }
}
