import { describe, expect, it } from 'vitest';
import { IMD_RADAR_STATIONS, ProcessedRadarResult, RadarProductKey } from '../domain/models/radar.model';
import { MAX_SCAN_AGE_MIN, composeRadarMosaic } from './radar-mosaic';
import { dequantizeRadar } from './radar-field';

const karaikal = IMD_RADAR_STATIONS.find(s => s.id === 'karaikal')!;
const cni = IMD_RADAR_STATIONS.find(s => s.id === 'chennai')!;
/** A point `t` of the way from Karaikal to Chennai (about 245 km apart, so their ranges overlap in between). */
const between = (t: number): [number, number] => [karaikal.lat + (cni.lat - karaikal.lat) * t, karaikal.lng + (cni.lng - karaikal.lng) * t];
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

/** The intensity at a place (nearest pixel of the composite). */
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
  it('gives each product its own range: PPZ reaches further than CAZ', () => {
    const caz = composeRadarMosaic(IMD_RADAR_STATIONS, [['karaikal', scan(karaikal, 'caz', 4.0)]], 0.5, 2800, 'caz')!;
    const ppz = composeRadarMosaic(IMD_RADAR_STATIONS, [['karaikal', scan(karaikal, 'ppz', 4.0)]], 0.5, 2800, 'ppz')!;
    // about 283 km away on the diagonal: beyond CAZ's range, inside PPZ's
    const diagonal: [number, number] = [karaikal.lat + 200 / 111.32, eastOf(karaikal, 200)[1]];
    expect(valueAt(caz, diagonal[0], diagonal[1])).toBe(0);
    expect(valueAt(ppz, diagonal[0], diagonal[1])).toBeCloseTo(4.0, 1);
  });

  it('shows a PPZ picture on its own: it is not left out for lacking a CAZ scan', () => {
    const m = composeRadarMosaic(IMD_RADAR_STATIONS, [['karaikal', scan(karaikal, 'ppz', 3.0)]], 0.5, 2800, 'ppz')!;
    const [lat, lng] = eastOf(karaikal, 60);
    expect(valueAt(m, lat, lng)).toBeCloseTo(3.0, 1);
  });

  it('supports PPI scan composed alone', () => {
    const ppiMosaic = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'ppi', 3.8)],
    ], undefined, undefined, 'ppi')!;
    const [lat, lng] = eastOf(karaikal, 40);
    expect(valueAt(ppiMosaic, lat, lng)).toBeCloseTo(3.8, 1);
  });

  it('where radars overlap, shows the strongest echo of either radar (no blending), wherever it is closer to', () => {
    const mosaic = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'caz', 4.0)],
      ['chennai', scan(cni, 'caz', 2.0)],
    ])!;
    expect(valueAt(mosaic, ...between(0.35))).toBeCloseTo(4.0, 1); // Karaikal's stronger echo, near Karaikal
    expect(valueAt(mosaic, ...between(0.65))).toBeCloseTo(4.0, 1); // and near Chennai too: Chennai sees it weaker
  });

  it('a point one radar sees as dry still shows the rain the other radar sees there', () => {
    const mosaic = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'caz', 0)],
      ['chennai', scan(cni, 'caz', 3.0)],
    ])!;
    expect(valueAt(mosaic, ...between(0.35))).toBeCloseTo(3.0, 1);
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

describe('live scans', () => {
  it('does not draw a live scan older than 45 minutes, and keeps the fresh stations', () => {
    const now = T0 + 60 * 60_000;
    const stale = scan(karaikal, 'caz', 2.0, 0);       // 60 min old
    const fresh = scan(cni, 'caz', 3.0, 30);       // 30 min old
    expect(composeRadarMosaic(IMD_RADAR_STATIONS, [['karaikal', stale]], 0.5, 2800, 'caz', now)).toBeNull();
    const m = composeRadarMosaic(IMD_RADAR_STATIONS, [['karaikal', stale], ['chennai', fresh]], 0.5, 2800, 'caz', now)!;
    expect(m.fieldData.bounds[0][0]).toBeGreaterThan(karaikal.lat - 1);   // the picture is Chennai's square only, not Karaikal's
    // without a clock (history frames) nothing is dropped
    expect(composeRadarMosaic(IMD_RADAR_STATIONS, [['karaikal', stale]])).not.toBeNull();
    expect(MAX_SCAN_AGE_MIN).toBe(45);
  });
});
