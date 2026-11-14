import { Injectable, computed, signal } from '@angular/core';

export const AMV_SITE = 'https://gowthamgta.github.io/atmos-satellite/amv/';

export interface AmvVectorProperties {
  u: number;
  v: number;
  speed: number;
  dir: number;
  p: number;
  z: number;
  layer: 'high' | 'mid' | 'low';
  sat: string;
  ch: string;
  qi: number;
  zen: number;
}

export interface AmvFeature {
  type: 'Feature';
  geometry: {
    type: 'Point';
    coordinates: [number, number]; // [lon, lat]
  };
  properties: AmvVectorProperties;
}

export interface AmvGeoJson {
  type: 'FeatureCollection';
  time: string;
  count: number;
  features: AmvFeature[];
}

export interface AmvFrameMeta {
  time: string;
  file: string;
  count: number;
  meteosat_count?: number;
  himawari_count?: number;
}

export interface AmvIndex {
  version: number;
  bounds: { west: number; east: number; south: number; north: number };
  frames: AmvFrameMeta[];
}

export type AmvLayerFilter = 'all' | 'high' | 'mid' | 'low';

@Injectable({ providedIn: 'root' })
export class AmvService {
  readonly active = signal<boolean>(false);
  readonly loading = signal<boolean>(false);
  readonly failed = signal<boolean>(false);
  readonly frames = signal<AmvFrameMeta[]>([]);
  readonly currentFrame = signal<AmvFrameMeta | null>(null);
  readonly currentGeoJson = signal<AmvGeoJson | null>(null);
  readonly layerFilter = signal<AmvLayerFilter>('all');
  readonly hoveredVector = signal<AmvVectorProperties | null>(null);

  /** Filtered GeoJSON features matching the active layer filter */
  readonly filteredGeoJson = computed<AmvGeoJson | null>(() => {
    const geo = this.currentGeoJson();
    if (!geo) return null;
    const filter = this.layerFilter();
    if (filter === 'all') return geo;
    const filteredFeatures = geo.features.filter(f => f.properties.layer === filter);
    return {
      ...geo,
      count: filteredFeatures.length,
      features: filteredFeatures
    };
  });

  /** Summary stats for the active AMV nowcast frame */
  readonly stats = computed(() => {
    const geo = this.currentGeoJson();
    if (!geo || !geo.features.length) return null;
    const total = geo.features.length;
    const high = geo.features.filter(f => f.properties.layer === 'high').length;
    const mid = geo.features.filter(f => f.properties.layer === 'mid').length;
    const low = geo.features.filter(f => f.properties.layer === 'low').length;
    const met = geo.features.filter(f => f.properties.sat.includes('Meteosat')).length;
    const him = geo.features.filter(f => f.properties.sat.includes('Himawari')).length;
    const avgSpd = geo.features.reduce((s, f) => s + f.properties.speed, 0) / total;
    const avgQi = geo.features.reduce((s, f) => s + f.properties.qi, 0) / total;
    return {
      total,
      high,
      mid,
      low,
      met,
      him,
      avgSpeedMps: Math.round(avgSpd * 10) / 10,
      avgQi: Math.round(avgQi * 10) / 10
    };
  });

  toggleActive(): void {
    const next = !this.active();
    this.active.set(next);
    if (next && !this.currentGeoJson()) {
      this.refresh();
    }
  }

  setLayerFilter(filter: AmvLayerFilter): void {
    this.layerFilter.set(filter);
  }

  setHoveredVector(v: AmvVectorProperties | null): void {
    this.hoveredVector.set(v);
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const res = await fetch(`${AMV_SITE}index.json?t=${Date.now()}`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const idx: AmvIndex = await res.json();
      const sorted = (idx.frames || []).sort((a, b) => a.time.localeCompare(b.time));
      this.frames.set(sorted);
      if (sorted.length > 0) {
        const latest = sorted[sorted.length - 1];
        this.currentFrame.set(latest);
        await this.loadFrame(latest);
      } else {
        this.loading.set(false);
      }
    } catch {
      await this.loadSampleFallback();
    }
  }

  async loadFrame(meta: AmvFrameMeta): Promise<void> {
    this.loading.set(true);
    try {
      const res = await fetch(`${AMV_SITE}${meta.file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geo: AmvGeoJson = await res.json();
      this.currentGeoJson.set(geo);
      this.loading.set(false);
    } catch {
      await this.loadSampleFallback();
    }
  }

  private async loadSampleFallback(): Promise<void> {
    try {
      const res = await fetch('/pipeline/site/amv/amv_20261114_160416.json');
      if (res.ok) {
        const geo: AmvGeoJson = await res.json();
        this.currentGeoJson.set(geo);
        this.loading.set(false);
        return;
      }
    } catch {
      // ignore
    }
    this.loading.set(false);
    this.failed.set(true);
  }
}
