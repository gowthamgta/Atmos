import { describe, expect, it } from 'vitest';
import { IMD_RADAR_STATIONS, ProcessedRadarResult, RadarProductKey } from '../domain/models/radar.model';
import { MERGED_PRODUCTS, composeRadarMosaic } from './radar-mosaic';
import { dequantizeRadar } from './radar-field';

const karaikal = IMD_RADAR_STATIONS.find(s => s.id === 'karaikal')!;
const kochi = IMD_RADAR_STATIONS.find(s => s.id === 'kochi')!;
const N = 120;

/** A scan of one station and product that has the same intensity everywhere on its square. */
function scan(station: (typeof IMD_RADAR_STATIONS)[number], product: RadarProductKey, value: number): ProcessedRadarResult {
  const config = station.products[product];
  return {
    stationId: station.id,
    dataUrl: '',
    fieldData: { field: new Float32Array(N * N).fill(value), cropW: N, cropH: N, cx: N / 2, cy: N / 2, radius: N / 2, bounds: config.bounds },
    timing: null,
    coordinates: config.maplibreCoordinates,
    isDisplayed: true,
  };
}

/** The merged intensity at a place (nearest pixel of the composite). */
function valueAt(result: ProcessedRadarResult, lat: number, lng: number): number {
  const { field, cropW, cropH, bounds } = result.fieldData;
  const [[south, west], [north, east]] = bounds;
  const x = Math.round(((lng - west) / (east - west)) * (cropW - 1));
  const y = Math.round(((north - lat) / (north - south)) * (cropH - 1));
  return field[y * cropW + x];
}

/** A point `km` due east of a station. */
const eastOf = (station: (typeof IMD_RADAR_STATIONS)[number], km: number): [number, number] => [
  station.lat,
  station.lng + km / (111.32 * Math.cos((station.lat * Math.PI) / 180)),
];

describe('composeRadarMosaic', () => {
  it('merges only CAZ and PPZ', () => {
    expect(MERGED_PRODUCTS).toEqual(['caz', 'ppz']);
  });

  it('takes the strongest of a station\'s scans where they overlap, without diluting it', () => {
    const mosaic = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'caz', 2.0)],
      ['karaikal:ppz', scan(karaikal, 'ppz', 3.5)],
    ])!;
    const [lat, lng] = eastOf(karaikal, 40);
    // one radar, two scans: the result is the stronger scan itself (a blend would pull it below 3.5)
    expect(valueAt(mosaic, lat, lng)).toBeCloseTo(3.5, 1);
  });

  it('keeps the wider scan where the narrower one does not reach', () => {
    const mosaic = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'caz', 2.0)],
      ['karaikal:ppz', scan(karaikal, 'ppz', 4.0)],
    ])!;
    const near = eastOf(karaikal, 60);
    const far = eastOf(karaikal, 200); // beyond PPZ (158 km), inside CAZ (255 km)
    expect(valueAt(mosaic, near[0], near[1])).toBeCloseTo(4.0, 1);
    expect(valueAt(mosaic, far[0], far[1])).toBeCloseTo(2.0, 1);
  });

  it('lets a strong CAZ show over a weaker PPZ too, and works with CAZ alone', () => {
    const both = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'caz', 4.2)],
      ['karaikal:ppz', scan(karaikal, 'ppz', 1.5)],
    ])!;
    const [lat, lng] = eastOf(karaikal, 50);
    expect(valueAt(both, lat, lng)).toBeCloseTo(4.2, 1);
    const alone = composeRadarMosaic(IMD_RADAR_STATIONS, [['karaikal', scan(karaikal, 'caz', 1.2)]])!;
    expect(valueAt(alone, lat, lng)).toBeCloseTo(1.2, 1);
  });

  it('supports PPI scan composed alone', () => {
    const ppiMosaic = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'ppi', 3.8)],
    ])!;
    const [lat, lng] = eastOf(karaikal, 40);
    expect(valueAt(ppiMosaic, lat, lng)).toBeCloseTo(3.8, 1);
  });

  it('still blends different stations where they overlap, keeping the storm core', () => {
    // Karaikal and Kochi are about 270 km apart in longitude, so a point between them is seen by both
    const lat = (karaikal.lat + kochi.lat) / 2;
    const lng = (karaikal.lng + kochi.lng) / 2;
    const mosaic = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'caz', 4.0)],
      ['karaikal:ppz', scan(karaikal, 'ppz', 4.0)],
      ['kochi', scan(kochi, 'caz', 2.0)],
    ])!;
    const v = valueAt(mosaic, lat, lng);
    // 0.8 * strongest + 0.2 * the distance-weighted average: between the two stations' values, close to the strong one
    expect(v).toBeGreaterThan(2.0);
    expect(v).toBeLessThanOrEqual(4.0);
    expect(v).toBeGreaterThan(3.2);
  });

  it('skips scans that are hidden as too old, and returns nothing when there is no scan', () => {
    const old = { ...scan(karaikal, 'caz', 3), isDisplayed: false };
    expect(composeRadarMosaic(IMD_RADAR_STATIONS, [['karaikal', old]])).toBeNull();
    expect(composeRadarMosaic(IMD_RADAR_STATIONS, [])).toBeNull();
    const result = composeRadarMosaic(IMD_RADAR_STATIONS, [['karaikal', scan(karaikal, 'caz', 3)]])!;
    expect(result.displayField).toBeDefined();
    const { cropW, cropH } = result.fieldData;
    const centre = Math.floor(cropH / 2) * cropW + Math.floor(cropW / 2);
    expect(dequantizeRadar(result.displayField![centre])).toBeCloseTo(3, 1); // the 8-bit picture matches the intensity
  });
});
