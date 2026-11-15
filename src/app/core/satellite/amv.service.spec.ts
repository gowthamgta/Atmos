import { describe, it, expect, beforeEach } from 'vitest';
import { AmvService, AmvGeoJson } from './amv.service';

describe('AmvService', () => {
  let service: AmvService;

  beforeEach(() => {
    service = new AmvService();
  });

  it('initializes with inactive state, low layer filter, and arrows style', () => {
    expect(service.active()).toBe(false);
    expect(service.layerFilter()).toBe('low');
    expect(service.sourceFilter()).toBe('all');
    expect(service.style()).toBe('arrows');
    expect(service.currentGeoJson()).toBeNull();
  });

  it('toggles active and style states correctly', () => {
    service.toggleActive();
    expect(service.active()).toBe(true);
    service.toggleActive();
    expect(service.active()).toBe(false);

    expect(service.style()).toBe('arrows');
    service.toggleStyle();
    expect(service.style()).toBe('barbs');
    service.setStyle('arrows');
    expect(service.style()).toBe('arrows');
  });

  it('filters vectors correctly according to layer and source filters', () => {
    const mockGeo: AmvGeoJson = {
      type: 'FeatureCollection',
      time: '2026-11-14T12:00:00Z',
      count: 4,
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
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [86, 12] },
          properties: { u: 15, v: 0, speed: 15, dir: 270, p: 850, z: 1500, layer: 'low', sat: 'ECMWF IFS', ch: '850hPa', qi: 95, zen: 0 }
        }
      ]
    };

    service.currentGeoJson.set(mockGeo);
    // Defaults to low level winds only (p >= 700 hPa)
    expect(service.filteredGeoJson()?.count).toBe(2);

    service.setLayerFilter('all');
    expect(service.filteredGeoJson()?.count).toBe(4);

    service.setLayerFilter('high');
    expect(service.filteredGeoJson()?.count).toBe(1);
    expect(service.filteredGeoJson()?.features[0].properties.layer).toBe('high');

    service.setLayerFilter('low');
    expect(service.filteredGeoJson()?.count).toBe(2);

    service.setSourceFilter('ecmwf');
    expect(service.filteredGeoJson()?.count).toBe(1);
    expect(service.filteredGeoJson()?.features[0].properties.sat).toBe('ECMWF IFS');

    service.setSourceFilter('satellite');
    expect(service.filteredGeoJson()?.count).toBe(1);
    expect(service.filteredGeoJson()?.features[0].properties.sat).toBe('Himawari-9');

    // Barb calculation: 15 m/s = 29.2 kt -> barb-30, green (#00e676)
    service.setSourceFilter('all');
    const lowFeatures = service.filteredGeoJson()?.features;
    const ecmwfFeat = lowFeatures?.find(f => f.properties.sat === 'ECMWF IFS');
    expect(ecmwfFeat?.properties.speed_kt).toBe(29.2);
    expect(ecmwfFeat?.properties.barb_id).toBe('barb-30');
    expect(ecmwfFeat?.properties.barb_color).toBe('#00e676');
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
