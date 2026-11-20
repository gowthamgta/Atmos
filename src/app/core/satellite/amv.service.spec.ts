import { describe, it, expect, beforeEach } from 'vitest';
import { AmvService, AmvGeoJson } from './amv.service';

describe('AmvService', () => {
  let service: AmvService;

  beforeEach(() => {
    service = new AmvService();
  });

  it('initializes with inactive state, low layer filter, and particles style', () => {
    expect(service.active()).toBe(false);
    expect(service.layerFilter()).toBe('low');
    expect(service.sourceFilter()).toBe('all');
    expect(service.style()).toBe('particles');
    expect(service.currentGeoJson()).toBeNull();
  });

  it('toggles active and style states correctly', () => {
    service.toggleActive();
    expect(service.active()).toBe(true);
    service.toggleActive();
    expect(service.active()).toBe(false);

    expect(service.style()).toBe('particles');
    service.toggleStyle();
    expect(service.style()).toBe('arrows');
    service.toggleStyle();
    expect(service.style()).toBe('barbs');
    service.setStyle('particles');
    expect(service.style()).toBe('particles');
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
    // Exclusively low-level winds (p >= 700 hPa). Middle and high clouds are discarded.
    expect(service.filteredGeoJson()?.count).toBe(2);

    service.setSourceFilter('ecmwf');
    expect(service.filteredGeoJson()?.count).toBe(1);
    expect(service.filteredGeoJson()?.features[0].properties.sat).toBe('ECMWF IFS');

    service.setSourceFilter('satellite');
    expect(service.filteredGeoJson()?.count).toBe(1);
    expect(service.filteredGeoJson()?.features[0].properties.sat).toBe('Himawari-9');

    // Barb calculation: 15 m/s = 29.2 kt -> barb-30
    service.setSourceFilter('all');
    const lowFeatures = service.filteredGeoJson()?.features;
    const ecmwfFeat = lowFeatures?.find(f => f.properties.sat === 'ECMWF IFS');
    expect(ecmwfFeat?.properties.speed_kt).toBe(29.2);
    expect(ecmwfFeat?.properties.barb_id).toBe('barb-30');
  });

  it('filters out inland semi-transparent cirrus contamination', () => {
    const mockCirrusGeo: AmvGeoJson = {
      type: 'FeatureCollection',
      time: '2026-11-14T12:00:00Z',
      count: 2,
      features: [
        {
          type: 'Feature',
          // Over Karnataka (76E, 14N), fast SSE wind (16 m/s, 150 deg) misassigned to 800 hPa
          geometry: { type: 'Point', coordinates: [76, 14] },
          properties: { u: -8, v: -13.8, speed: 16, dir: 150, p: 800, z: 2000, layer: 'low', sat: 'Meteosat-9', ch: 'IR_108', qi: 85, zen: 40 }
        },
        {
          type: 'Feature',
          // Genuine gentle low-level easterly (5 m/s, 70 deg)
          geometry: { type: 'Point', coordinates: [76, 14] },
          properties: { u: -4.7, v: -1.7, speed: 5, dir: 70, p: 850, z: 1500, layer: 'low', sat: 'Meteosat-9', ch: 'IR_108', qi: 85, zen: 40 }
        }
      ]
    };

    service.currentGeoJson.set(mockCirrusGeo);
    // The fast SSE cirrus contamination vector is eliminated; only genuine easterly remains
    expect(service.filteredGeoJson()?.count).toBe(1);
    expect(service.filteredGeoJson()?.features[0].properties.speed).toBe(5);
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

  it('synchronizes to the closest AMV frame matching satellite time', () => {
    service.frames.set([
      { time: '2026-11-16T12:00:00Z', file: 'amv_1200.json', count: 7000 },
      { time: '2026-11-16T12:15:00Z', file: 'amv_1215.json', count: 7100 },
      { time: '2026-11-16T12:30:00Z', file: 'amv_1230.json', count: 7200 }
    ]);

    // Satellite at 12:14:00Z -> should pick 12:15:00Z frame
    const satTime = Date.parse('2026-11-16T12:14:00Z');
    service.syncWithSatelliteTime(satTime);
    expect(service.currentFrame()?.file).toBe('amv_1215.json');
    expect(service.currentFrameTimeMs()).toBe(Date.parse('2026-11-16T12:15:00Z'));
    expect(service.currentFrameTimeLabel()).toContain('IST');

    // Satellite moves to 12:31:00Z -> should advance to 12:30:00Z frame
    service.syncWithSatelliteTime(Date.parse('2026-11-16T12:31:00Z'));
    expect(service.currentFrame()?.file).toBe('amv_1230.json');
  });

  it('handles cycloneData loading correctly without crashing', () => {
    expect(service.cycloneData()).toBeNull();
  });
});
