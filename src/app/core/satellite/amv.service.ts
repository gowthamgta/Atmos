import { Injectable, computed, signal, inject, effect, OnDestroy } from '@angular/core';
import type { WindFrame } from '../forecast/particle-system';
import { SatelliteService } from './satellite.service';
import { istClock } from '../forecast/model-runs';

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
export type AmvStyle = 'particles' | 'arrows' | 'barbs';

@Injectable({ providedIn: 'root' })
export class AmvService implements OnDestroy {
  readonly active = signal<boolean>(false);
  readonly loading = signal<boolean>(false);
  readonly failed = signal<boolean>(false);
  readonly frames = signal<AmvFrameMeta[]>([]);
  readonly currentFrame = signal<AmvFrameMeta | null>(null);
  readonly currentGeoJson = signal<AmvGeoJson | null>(null);
  readonly layerFilter = signal<AmvLayerFilter>('low');
  readonly sourceFilter = signal<AmvSourceFilter>('all');
  readonly style = signal<AmvStyle>('particles');
  readonly dimSatellite = signal<boolean>(false);
  readonly hoveredVector = signal<AmvVectorProperties | null>(null);

  /** Timestamp in epoch ms of currently displayed AMV frame */
  readonly currentFrameTimeMs = computed<number | null>(() => {
    const f = this.currentFrame();
    return f ? Date.parse(f.time) : null;
  });

  /** Human-readable time label for current AMV frame in IST (e.g. '20:19 IST') */
  readonly currentFrameTimeLabel = computed<string>(() => {
    const ms = this.currentFrameTimeMs();
    return ms && Number.isFinite(ms) ? istClock(ms) : '';
  });

  /** Filtered GeoJSON according to selected altitude level ('low' | 'mid' | 'high' | 'all') */
  readonly filteredGeoJson = computed<AmvGeoJson | null>(() => {
    const geo = this.currentGeoJson();
    if (!geo) return null;
    const srcFilter = this.sourceFilter();
    const lFilter = this.layerFilter();

    // ── Step 1: Filter by altitude level ──
    const levelFiltered = geo.features.filter(f => {
      const { p, layer, sat, speed, dir } = f.properties;
      const [lon, lat] = f.geometry.coordinates;

      if (lFilter === 'low') {
        // Strict low-level: surface to 700 hPa (~1.5 km boundary layer)
        if (layer === 'high' || layer === 'mid') return false;
        if (p != null && p < 700.0) return false;

        // Reject cirrus contamination in satellite vectors:
        if (!(sat || '').includes('ECMWF')) {
          if (speed > 15.0) return false;
          if (lon >= 70.0 && lon <= 85.0 && lat >= 8.0 && lat <= 22.0 &&
              speed > 10.0 && dir >= 100.0 && dir <= 220.0) return false;
        }
      } else if (lFilter === 'mid') {
        // Mid-level: 700 hPa to 400 hPa (~3–7 km mid-troposphere)
        if (layer === 'high' || layer === 'low') return false;
        if (p != null && (p < 400.0 || p >= 700.0)) return false;
      } else if (lFilter === 'high') {
        // High-level: < 400 hPa (~7–14 km cirrus / jet stream)
        if (layer === 'low' || layer === 'mid') return false;
        if (p != null && p >= 400.0) return false;
      }
      // 'all': allow all levels

      return true;
    });

    const ecmwfAll = levelFiltered.filter(f => (f.properties.sat || '').includes('ECMWF'));
    const satAll = levelFiltered.filter(f => !(f.properties.sat || '').includes('ECMWF'));

    // ── Step 2: Synoptic QC against 850 hPa reference flow (for low level) ──
    let cleanSat: AmvFeature[] = satAll;
    if (lFilter === 'low') {
      const refGrid = new Map<string, { u: number; v: number; spd: number }>();
      const BUCKET = 0.5;
      for (const ef of ecmwfAll) {
        const [ex, ey] = ef.geometry.coordinates;
        const key = `${Math.round(ex / BUCKET)}:${Math.round(ey / BUCKET)}`;
        refGrid.set(key, { u: ef.properties.u, v: ef.properties.v, spd: ef.properties.speed });
      }

      const verified: AmvFeature[] = [];
      for (const sv of satAll) {
        const [sx, sy] = sv.geometry.coordinates;
        const key = `${Math.round(sx / BUCKET)}:${Math.round(sy / BUCKET)}`;
        const ref = refGrid.get(key);
        if (ref) {
          const vecDiff = Math.hypot(sv.properties.u - ref.u, sv.properties.v - ref.v);
          if (sv.properties.speed > 10.0 && sv.properties.speed > ref.spd + 4.0) continue;
          if (vecDiff > 7.0) continue;
        }
        verified.push(sv);
      }
      cleanSat = verified;
    }

    // ── Step 3: Spatial thinning — one arrow per ~0.5° cell for comfortable density ──
    const THIN = 0.5; // ~55 km grid
    let merged: AmvFeature[];

    if (srcFilter === 'satellite') {
      merged = cleanSat;
    } else if (srcFilter === 'ecmwf') {
      merged = ecmwfAll;
    } else {
      // Satellite vectors take priority; ECMWF fills gaps only
      const occupied = new Set<string>();
      for (const sv of cleanSat) {
        const [sx, sy] = sv.geometry.coordinates;
        occupied.add(`${Math.round(sx / THIN)}:${Math.round(sy / THIN)}`);
      }
      const gapFill = ecmwfAll.filter(ef => {
        const [ex, ey] = ef.geometry.coordinates;
        return !occupied.has(`${Math.round(ex / THIN)}:${Math.round(ey / THIN)}`);
      });
      merged = [...cleanSat, ...gapFill];
    }

    // Thin to one per 0.5° cell (keep highest-QI or first encountered)
    const thinGrid = new Map<string, AmvFeature>();
    for (const f of merged) {
      const [fx, fy] = f.geometry.coordinates;
      const key = `${Math.round(fx / THIN)}:${Math.round(fy / THIN)}`;
      const existing = thinGrid.get(key);
      if (!existing || f.properties.qi > existing.properties.qi) {
        thinGrid.set(key, f);
      }
    }
    const thinned = Array.from(thinGrid.values());

    // ── Step 4: Normalize properties ──
    const normalized = thinned.map(f => {
      const spd = f.properties.speed;
      const spdKt = f.properties.speed_kt ?? Math.round(spd * 1.94384 * 10) / 10;
      const step = Math.min(100, Math.max(0, Math.round(spdKt / 5) * 5));
      return {
        ...f,
        properties: {
          ...f.properties,
          speed_kt: spdKt,
          barb_id: f.properties.barb_id ?? `barb-${step}`,
          barb_color: f.properties.barb_color ?? (spdKt >= 20.0 ? '#00e676' : '#334155')
        }
      };
    });

    return { ...geo, count: normalized.length, features: normalized };
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
    const current = this.style();
    if (current === 'particles') this.style.set('arrows');
    else if (current === 'arrows') this.style.set('barbs');
    else this.style.set('particles');
  }

  /** Continuous WindFrame for smooth WebGL particle streamlines across the domain */
  readonly windFrame = computed<WindFrame | null>(() => {
    const filtered = this.filteredGeoJson();
    if (!filtered || filtered.features.length === 0) return null;
    return amvToWindFrame(filtered.features);
  });

  toggleDimSatellite(): void {
    this.dimSatellite.update(v => !v);
  }

  setHoveredVector(v: AmvVectorProperties | null): void {
    this.hoveredVector.set(v);
  }

  private checkTimer: ReturnType<typeof setInterval> | null = null;
  readonly geoJsonCache = new Map<string, AmvGeoJson>();
  private readonly satellite: SatelliteService | null = null;

  constructor() {
    try {
      this.satellite = inject(SatelliteService, { optional: true });
    } catch {
      this.satellite = null;
    }

    if (this.satellite) {
      try {
        effect(() => {
          const active = this.active();
          const satCurrent = this.satellite?.current();
          const frames = this.frames();
          if (!active || frames.length === 0) return;

          // If satellite layer is active and viewing a specific frame, sync AMV with that frame
          if (this.satellite?.active() && satCurrent) {
            this.syncWithSatelliteTime(satCurrent.timeMs);
          }
        });
      } catch {}
    }

    try {
      effect(() => {
        const active = this.active();
        if (active) {
          this.startChecking();
        } else {
          this.stopChecking();
        }
      });
    } catch {}
  }

  ngOnDestroy(): void {
    this.stopChecking();
    this.geoJsonCache.clear();
  }

  startChecking(): void {
    if (this.checkTimer === null && typeof setInterval !== 'undefined') {
      this.checkTimer = setInterval(() => void this.checkForNewRuns(), 2 * 60_000);
    }
  }

  stopChecking(): void {
    if (this.checkTimer !== null) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /** Checks index.json for any newly published satellite AMV runs */
  async checkForNewRuns(): Promise<void> {
    if (!this.active()) return;
    try {
      const res = await fetch(`${AMV_SITE}index.json?t=${Date.now()}`, { cache: 'no-cache' });
      if (!res.ok) return;
      const idx: AmvIndex = await res.json();
      const sorted = (idx.frames || []).sort((a, b) => a.time.localeCompare(b.time));
      const oldFrames = this.frames();
      const oldLatestTime = oldFrames.length > 0 ? oldFrames[oldFrames.length - 1].time : '';
      const newLatest = sorted.length > 0 ? sorted[sorted.length - 1] : null;

      this.frames.set(sorted);

      if (newLatest && newLatest.time !== oldLatestTime) {
        const satCurrent = this.satellite?.current();
        const satIsLive = !this.satellite?.active() || !satCurrent || this.satellite.position() >= this.satellite.frames().length - 1;
        if (satIsLive) {
          this.currentFrame.set(newLatest);
          await this.loadFrame(newLatest);
        }
      }
    } catch {
      // ignore network errors during background check
    }
  }

  /** Synchronize AMV frame to closest timestamp of the active satellite frame */
  syncWithSatelliteTime(satTimeMs: number): void {
    const frames = this.frames();
    if (frames.length === 0) return;

    let closest: AmvFrameMeta | null = null;
    let minDiff = Infinity;
    for (const f of frames) {
      const fTimeMs = Date.parse(f.time);
      if (!Number.isFinite(fTimeMs)) continue;
      const diff = Math.abs(fTimeMs - satTimeMs);
      if (diff < minDiff) {
        minDiff = diff;
        closest = f;
      }
    }

    if (closest && minDiff <= 45 * 60_000 && closest.file !== this.currentFrame()?.file) {
      this.currentFrame.set(closest);
      void this.loadFrame(closest);
    }
  }

  private prefetchNearbyFrames(currentMeta: AmvFrameMeta): void {
    const frames = this.frames();
    const idx = frames.findIndex(f => f.file === currentMeta.file);
    if (idx === -1) return;
    const nearby = frames.slice(Math.max(0, idx - 2), Math.min(frames.length, idx + 3));
    for (const f of nearby) {
      if (!this.geoJsonCache.has(f.file)) {
        void fetch(`${AMV_SITE}${f.file}`)
          .then(r => r.ok ? r.json() : null)
          .then(data => { if (data) this.geoJsonCache.set(f.file, data); })
          .catch(() => undefined);
      }
    }
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
        const satCurrent = this.satellite?.current();
        if (this.satellite?.active() && satCurrent) {
          this.syncWithSatelliteTime(satCurrent.timeMs);
        } else {
          const latest = sorted[sorted.length - 1];
          this.currentFrame.set(latest);
          await this.loadFrame(latest);
        }
      } else {
        this.loading.set(false);
      }
    } catch {
      await this.loadSampleFallback();
    }
  }

  async loadFrame(meta: AmvFrameMeta): Promise<void> {
    const cached = this.geoJsonCache.get(meta.file);
    if (cached) {
      this.currentGeoJson.set(cached);
      return;
    }
    this.loading.set(true);
    try {
      const res = await fetch(`${AMV_SITE}${meta.file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geo: AmvGeoJson = await res.json();
      this.geoJsonCache.set(meta.file, geo);
      this.currentGeoJson.set(geo);
      this.loading.set(false);
      this.prefetchNearbyFrames(meta);
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

/** Interpolates discrete AMV vectors onto a regular grid for smooth WebGL particle animation */
export function amvToWindFrame(features: AmvFeature[]): WindFrame | null {
  if (!features || features.length === 0) return null;

  const latMin = 2.0;
  const latMax = 20.0;
  const lonMin = 70.0;
  const lonMax = 99.0;
  const step = 0.25;
  const nx = Math.round((lonMax - lonMin) / step) + 1; // 117
  const ny = Math.round((latMax - latMin) / step) + 1; // 73
  const count = nx * ny;

  const uA = new Float32Array(count);
  const vA = new Float32Array(count);

  const bucketSize = 0.5;
  const buckets = new Map<string, { u: number; v: number; x: number; y: number }[]>();

  for (const f of features) {
    const [x, y] = f.geometry.coordinates;
    const bx = Math.round(x / bucketSize);
    const by = Math.round(y / bucketSize);
    const key = `${bx}:${by}`;
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push({ u: f.properties.u, v: f.properties.v, x, y });
  }

  for (let iy = 0; iy < ny; iy++) {
    const lat = latMax - iy * step;
    const by = Math.round(lat / bucketSize);

    for (let ix = 0; ix < nx; ix++) {
      const lon = lonMin + ix * step;
      const bx = Math.round(lon / bucketSize);
      const idx = iy * nx + ix;

      let sumU = 0;
      let sumV = 0;
      let sumW = 0;

      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          const bList = buckets.get(`${bx + dx}:${by + dy}`);
          if (!bList) continue;
          for (let k = 0; k < bList.length; k++) {
            const v = bList[k];
            const d2 = (lon - v.x) ** 2 + (lat - v.y) ** 2;
            if (d2 < 2.5) {
              const w = 1.0 / (d2 + 0.04);
              sumU += v.u * w;
              sumV += v.v * w;
              sumW += w;
            }
          }
        }
      }

      if (sumW > 0) {
        uA[idx] = sumU / sumW;
        vA[idx] = sumV / sumW;
      } else {
        uA[idx] = 0;
        vA[idx] = 0;
      }
    }
  }

  return {
    grid: { latMax, latMin, lonMin, lonMax, step, nx, ny },
    uA,
    vA,
    uB: uA,
    vB: vA,
    mix: 0
  };
}
