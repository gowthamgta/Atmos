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
  speed_kt?: number;
  barb_id?: string;
  barb_color?: string;
  source_type?: 'satellite_amv' | 'model_analysis';
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
  ecmwf_count?: number;
}

export interface AmvIndex {
  version: number;
  bounds: { west: number; east: number; south: number; north: number };
  frames: AmvFrameMeta[];
}

export type AmvLayerFilter = 'all' | 'high' | 'mid' | 'low';
export type AmvSourceFilter = 'all' | 'satellite' | 'ecmwf';
export type AmvStyle = 'barbs' | 'arrows';

@Injectable({ providedIn: 'root' })
export class AmvService {
  readonly active = signal<boolean>(false);
  readonly loading = signal<boolean>(false);
  readonly failed = signal<boolean>(false);
  readonly frames = signal<AmvFrameMeta[]>([]);
  readonly currentFrame = signal<AmvFrameMeta | null>(null);
  readonly currentGeoJson = signal<AmvGeoJson | null>(null);
  readonly layerFilter = signal<AmvLayerFilter>('low');
  readonly sourceFilter = signal<AmvSourceFilter>('all');
  readonly style = signal<AmvStyle>('arrows');
  readonly dimSatellite = signal<boolean>(false);
  readonly hoveredVector = signal<AmvVectorProperties | null>(null);

  /** Filtered GeoJSON features strictly focused on low-level winds (p >= 700 hPa), discarding middle and high clouds */
  readonly filteredGeoJson = computed<AmvGeoJson | null>(() => {
    const geo = this.currentGeoJson();
    if (!geo) return null;
    const sf = this.sourceFilter();

    // Exclusively low-level winds (p >= 700 hPa). Discard ALL middle and high clouds.
    let list = geo.features.filter(f => {
      const p = f.properties.p;
      const layer = f.properties.layer;
      if (layer === 'high' || layer === 'mid') return false;
      if (p !== undefined && p !== null && p < 700.0) return false;
      return true;
    });

    if (sf === 'satellite') {
      list = list.filter(f => f.properties.sat.includes('Meteosat') || f.properties.sat.includes('Himawari'));
    } else if (sf === 'ecmwf') {
      list = list.filter(f => f.properties.sat.includes('ECMWF'));
    }

    // Ensure barb_id and speed_kt exist for all features
    const normalized = list.map(f => {
      const spd = f.properties.speed;
      const spdKt = f.properties.speed_kt ?? Math.round(spd * 1.94384 * 10) / 10;
      const step = Math.min(100, Math.max(0, Math.round(spdKt / 5) * 5));
      const barbId = f.properties.barb_id ?? `barb-${step}`;
      const barbColor = f.properties.barb_color ?? (spdKt >= 20.0 ? '#00e676' : '#334155');
      return {
        ...f,
        properties: {
          ...f.properties,
          speed_kt: spdKt,
          barb_id: barbId,
          barb_color: barbColor
        }
      };
    });

    return {
      ...geo,
      count: normalized.length,
      features: normalized
    };
  });

  /** Summary stats for the active AMV nowcast frame */
  readonly stats = computed(() => {
    const geo = this.currentGeoJson();
    if (!geo || !geo.features.length) return null;
    const total = geo.features.length;
    const high = geo.features.filter(f => f.properties.layer === 'high').length;
    const mid = geo.features.filter(f => f.properties.layer === 'mid').length;
    const low = geo.features.filter(f => f.properties.layer === 'low' || f.properties.p >= 700.0).length;
    const met = geo.features.filter(f => f.properties.sat.includes('Meteosat')).length;
    const him = geo.features.filter(f => f.properties.sat.includes('Himawari')).length;
    const ecmwf = geo.features.filter(f => f.properties.sat.includes('ECMWF')).length;
    const gale = geo.features.filter(f => {
      const kt = f.properties.speed_kt ?? (f.properties.speed * 1.94384);
      return kt >= 20.0;
    }).length;
    const avgSpd = geo.features.reduce((s, f) => s + f.properties.speed, 0) / total;
    const avgQi = geo.features.reduce((s, f) => s + f.properties.qi, 0) / total;
    return {
      total,
      high,
      mid,
      low,
      met,
      him,
      ecmwf,
      gale,
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

  setSourceFilter(filter: AmvSourceFilter): void {
    this.sourceFilter.set(filter);
  }

  setStyle(style: AmvStyle): void {
    this.style.set(style);
  }

  toggleStyle(): void {
    this.style.set(this.style() === 'barbs' ? 'arrows' : 'barbs');
  }

  toggleDimSatellite(): void {
    this.dimSatellite.update(v => !v);
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
