import { describe, it, expect, beforeEach } from 'vitest';
import { AmvService, AmvGeoJson } from './amv.service';

describe('AmvService', () => {
  let service: AmvService;

  beforeEach(() => {
    service = new AmvService();
  });

  it('initializes with inactive state and all layer filter', () => {
    expect(service.active()).toBe(false);
    expect(service.layerFilter()).toBe('all');
    expect(service.currentGeoJson()).toBeNull();
  });

  it('toggles active state correctly', () => {
    service.toggleActive();
    expect(service.active()).toBe(true);
    service.toggleActive();
    expect(service.active()).toBe(false);
  });

  it('filters vectors correctly according to layer filter', () => {
    const mockGeo: AmvGeoJson = {
      type: 'FeatureCollection',
      time: '2026-11-14T12:00:00Z',
      count: 3,
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [80, 13] },
          properties: { u: 10, v: 0, speed: 10, dir: 270, p: 250, z: 10800, layer: 'high', sat: 'Meteosat-9', ch: 'IR_108', qi: 85, zen: 40 }
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [82, 14] },
          properties: { u: 5, v: 5, speed: 7.07, dir: 225, p: 500, z: 5800, layer: 'mid', sat: 'Meteosat-9', ch: 'WV_062', qi: 80, zen: 42 }
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [85, 11] },
          properties: { u: -4, v: 0, speed: 4, dir: 90, p: 850, z: 1500, layer: 'low', sat: 'Himawari-9', ch: 'B13', qi: 78, zen: 58 }
        }
      ]
    };

    service.currentGeoJson.set(mockGeo);
    expect(service.filteredGeoJson()?.count).toBe(3);

    service.setLayerFilter('high');
    expect(service.filteredGeoJson()?.count).toBe(1);
    expect(service.filteredGeoJson()?.features[0].properties.layer).toBe('high');

    service.setLayerFilter('mid');
    expect(service.filteredGeoJson()?.count).toBe(1);
    expect(service.filteredGeoJson()?.features[0].properties.layer).toBe('mid');

    service.setLayerFilter('low');
    expect(service.filteredGeoJson()?.count).toBe(1);
    expect(service.filteredGeoJson()?.features[0].properties.layer).toBe('low');
  });

  it('computes accurate statistical metrics', () => {
    const mockGeo: AmvGeoJson = {
      type: 'FeatureCollection',
      time: '2026-11-14T12:00:00Z',
      count: 2,
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [80, 13] },
          properties: { u: 10, v: 0, speed: 10, dir: 270, p: 250, z: 10800, layer: 'high', sat: 'Meteosat-9', ch: 'IR_108', qi: 90, zen: 40 }
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [85, 11] },
          properties: { u: 0, v: 20, speed: 20, dir: 180, p: 850, z: 1500, layer: 'low', sat: 'Himawari-9', ch: 'B13', qi: 80, zen: 58 }
        }
      ]
    };

    service.currentGeoJson.set(mockGeo);
    const stats = service.stats();
    expect(stats).not.toBeNull();
    expect(stats?.total).toBe(2);
    expect(stats?.high).toBe(1);
    expect(stats?.low).toBe(1);
    expect(stats?.met).toBe(1);
    expect(stats?.him).toBe(1);
    expect(stats?.avgSpeedMps).toBe(15.0);
    expect(stats?.avgQi).toBe(85.0);
  });
});
