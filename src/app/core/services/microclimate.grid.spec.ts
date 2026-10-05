import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { MicroclimateService } from './microclimate.service';
import {
  REGIONAL_500M_BOUNDS,
  REGIONAL_HEATMAP_WIDTH,
  REGIONAL_HEATMAP_HEIGHT,
  rasterColumnLongitude,
  rasterRowLatitude,
  setTerrainRaster
} from '../domain/models/microclimate.model';
import { loadBakedTerrain } from '../../../testing/baked-terrain';

describe('MicroclimateService 500 m base grids', () => {
  let service: MicroclimateService;

  beforeEach(() => {
    // Keep the constructor's terrain + live-model fetches offline; defaults are used instead
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    setTerrainRaster(loadBakedTerrain());
    service = TestBed.inject(MicroclimateService);
    // Re-reference the offline-estimate nodes to the real terrain, as the app does once it loads
    (service as any).initDefaultSpatialGrid();
  });

  afterEach(() => {
    setTerrainRaster(null);
    vi.unstubAllGlobals();
  });

  it('matches per-point sampling across the state', () => {
    const svc = service as any;
    const t0 = performance.now();
    svc.initBaseSpatialGrids();
    const fastMs = performance.now() - t0;

    const w = REGIONAL_HEATMAP_WIDTH;
    const h = REGIONAL_HEATMAP_HEIGHT;
    // Interior cells only: the last row/column clamp slightly differently in the bilinear terrain lookup
    const points: { idx: number; lat: number; lon: number }[] = [];
    for (let y = 3; y < h - 2; y += 11) {
      const lat = rasterRowLatitude(y, h, REGIONAL_500M_BOUNDS);
      for (let x = 3; x < w - 2; x += 11) {
        points.push({ idx: y * w + x, lat, lon: rasterColumnLongitude(x, w, REGIONAL_500M_BOUNDS) });
      }
    }

    // Original per-point path (weather + rain + cape per cell), timed on its own
    const t1 = performance.now();
    const samples = points.map(p => ({
      weather: service.sampleSpatialWeather(p.lat, p.lon),
      rain: service.sampleSpatialRain(p.lat, p.lon),
      cape: service.sampleSpatialCape(p.lat, p.lon)
    }));
    const slowMs = ((performance.now() - t1) * (w * h)) / points.length;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const s = samples[i];
      // The raster lookup and the point lookup may differ by a metre of terrain at most
      expect(Math.abs(svc.cachedBaseTempGrid[p.idx] - s.weather.temp)).toBeLessThanOrEqual(0.2);
      expect(Math.abs(svc.cachedBaseHumGrid[p.idx] - s.weather.hum)).toBeLessThanOrEqual(1);
      expect(Math.abs(svc.cachedBaseRainGrid[p.idx] - s.rain)).toBeLessThanOrEqual(0.2);
      expect(Math.abs(svc.cachedBaseCapeGrid[p.idx] - s.cape)).toBeLessThanOrEqual(2);
    }
    console.info(`[grid] single-pass ${fastMs.toFixed(0)} ms vs per-point ~${slowMs.toFixed(0)} ms (${points.length} cells checked)`);
    expect(points.length).toBeGreaterThan(7000);
  });

  it('shows real terrain in the downscaled fields', () => {
    const svc = service as any;
    svc.initBaseSpatialGrids();
    const w = REGIONAL_HEATMAP_WIDTH;
    const h = REGIONAL_HEATMAP_HEIGHT;
    const b = REGIONAL_500M_BOUNDS;
    const cell = (lat: number, lon: number) => {
      // Invert the Mercator rows by searching the (monotonic) row latitudes
      let lo = 0, hi = h - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (rasterRowLatitude(mid, h, b) > lat) lo = mid; else hi = mid;
      }
      const x = Math.round(((lon - b.minLon) / (b.maxLon - b.minLon)) * (w - 1));
      return lo * w + x;
    };

    const ooty = svc.cachedBaseTempGrid[cell(11.41, 76.69)];
    const chennai = svc.cachedBaseTempGrid[cell(13.08, 80.27)];
    // High range is well over 6 C cooler than the coast at the same time
    expect(chennai - ooty).toBeGreaterThan(6);
  });
});
