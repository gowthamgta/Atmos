import { describe, expect, it } from 'vitest';
import { IMD_RADAR_STATIONS, ProcessedRadarResult, RadarProductKey } from '../domain/models/radar.model';
import { MAX_MERGE_GAP_MIN, MERGED_PRODUCTS, composeRadarMosaic } from './radar-mosaic';
import { dequantizeRadar } from './radar-field';

const karaikal = IMD_RADAR_STATIONS.find(s => s.id === 'karaikal')!;
const kochi = IMD_RADAR_STATIONS.find(s => s.id === 'kochi')!;
const N = 120;

/** A scan of one station and product that has the same intensity everywhere on its square. */
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const at = (minutes: number) => ({ ist: '', utc: '', date: '', epochMs: T0 + minutes * 60_000 });

function scan(station: (typeof IMD_RADAR_STATIONS)[number], product: RadarProductKey, value: number, minutes = 0): ProcessedRadarResult {
  const config = station.products[product];
  return {
    stationId: station.id,
    dataUrl: '',
    fieldData: { field: new Float32Array(N * N).fill(value), cropW: N, cropH: N, cx: N / 2, cy: N / 2, radius: N / 2, bounds: config.bounds },
    timing: at(minutes),
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

  it('shows each scan out to its own range: PPZ reaches much further than CAZ', () => {
    const mosaic = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'caz', 2.0)],
      ['karaikal:ppz', scan(karaikal, 'ppz', 4.0)],
    ])!;
    const near = eastOf(karaikal, 60); // both see it: the stronger wins
    const far = eastOf(karaikal, 400); // beyond CAZ (255 km), inside PPZ (500 km)
    // the square's corner: inside the picture's box but 640 km away, beyond the circle the radar can see
    const beyond: [number, number] = [karaikal.lat + 450 / 111.32, eastOf(karaikal, 450)[1]];
    expect(valueAt(mosaic, near[0], near[1])).toBeCloseTo(4.0, 1);
    expect(valueAt(mosaic, far[0], far[1])).toBeCloseTo(4.0, 1);
    expect(valueAt(mosaic, beyond[0], beyond[1])).toBe(0);
  });

  it('keeps CAZ where PPZ is weaker, and CAZ alone covers only its own range', () => {
    const mosaic = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'caz', 3.0)],
      ['karaikal:ppz', scan(karaikal, 'ppz', 1.0)],
    ])!;
    const mid = eastOf(karaikal, 200);
    expect(valueAt(mosaic, mid[0], mid[1])).toBeCloseTo(3.0, 1);
    const far = eastOf(karaikal, 400);
    expect(valueAt(mosaic, far[0], far[1])).toBeCloseTo(1.0, 1);
  });

  it('lets a strong CAZ show over a weaker PPZ at close range too, and works with CAZ alone', () => {
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
    ], undefined, undefined, 'ppi')!;
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

describe('merging only when the scans are close in time', () => {
  const east = (km: number) => eastOf(karaikal, km);
  const merged = (ppzMinutes: number) =>
    composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'caz', 2.0, 0)],
      ['karaikal:ppz', scan(karaikal, 'ppz', 4.0, ppzMinutes)],
    ])!;

  it('uses PPZ when it is within the limit of CAZ, before or after', () => {
    for (const gap of [0, 10, 19, -19]) {
      const m = merged(gap);
      const [lat, lng] = east(60);
      expect(valueAt(m, lat, lng)).toBeCloseTo(4.0, 1); // PPZ is stronger here: it took part
      const far = east(400);
      expect(valueAt(m, far[0], far[1])).toBeCloseTo(4.0, 1); // and its longer range is shown
    }
  });

  it('keeps CAZ alone when PPZ is 20 minutes or more apart', () => {
    expect(MAX_MERGE_GAP_MIN).toBe(20);
    for (const gap of [20, 35, -20, -90]) {
      const m = merged(gap);
      const [lat, lng] = east(60);
      expect(valueAt(m, lat, lng)).toBeCloseTo(2.0, 1); // CAZ's value, PPZ ignored
      const [[south], [north]] = m.fieldData.bounds;
      expect((north - south) * 111.32).toBeLessThan(2 * 260); // the picture is only as big as CAZ's range, not PPZ's
    }
  });

  it('decides per station: a stale PPZ at one radar does not affect another radar', () => {
    const m = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'caz', 2.0, 0)],
      ['karaikal:ppz', scan(karaikal, 'ppz', 4.0, 45)], // too old for Karaikal
      ['kochi', scan(kochi, 'caz', 1.5, 0)],
      ['kochi:ppz', scan(kochi, 'ppz', 3.5, 5)], // fresh for Kochi
    ])!;
    const k = east(60);
    expect(valueAt(m, k[0], k[1])).toBeCloseTo(2.0, 1);
    const [lat, lng] = eastOf(kochi, 30);
    expect(valueAt(m, lat, lng)).toBeCloseTo(3.5, 1);
  });

  it('leaves PPZ out when its time or the CAZ scan is unknown', () => {
    const noTime = { ...scan(karaikal, 'ppz', 4.0), timing: null };
    const m = composeRadarMosaic(IMD_RADAR_STATIONS, [['karaikal', scan(karaikal, 'caz', 2.0)], ['karaikal:ppz', noTime]])!;
    const [lat, lng] = east(60);
    expect(valueAt(m, lat, lng)).toBeCloseTo(2.0, 1);
    expect(composeRadarMosaic(IMD_RADAR_STATIONS, [['karaikal:ppz', scan(karaikal, 'ppz', 4.0)]])).toBeNull();
  });
});
