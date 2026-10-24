import { describe, expect, it } from 'vitest';
import { IMD_RADAR_STATIONS, ProcessedRadarResult, RadarProductKey } from '../domain/models/radar.model';
import { MAX_SCAN_AGE_MIN, OVERLAP_FADE_OLDEST, OVERLAP_FADE_ONE_SCAN, composeRadarMosaic, overlapFade, ringKey } from './radar-mosaic';
import { stackPrimary, stackRings } from './radar.service';
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

describe('the stack (All): PPI inside, CAZ around it, PPZ outside', () => {
  const stack = (values: Partial<Record<RadarProductKey, number>>, minutes: Partial<Record<RadarProductKey, number>> = {}) => {
    const have = (p: RadarProductKey) => values[p] !== undefined;
    const rings = stackRings(karaikal, have).map(([p, r]) => [ringKey('karaikal', p), r] as const);
    const sources = stackRings(karaikal, have).map(([p]) => [ringKey('karaikal', p), scan(karaikal, p, values[p]!, minutes[p] ?? 0)] as [string, ProcessedRadarResult]);
    return composeRadarMosaic(IMD_RADAR_STATIONS, sources, 0.5, 2800, 'ppz', undefined, new Map(rings))!;
  };

  it('rings Karaikal inside out by range: PPI to 150 km, CAZ to 250 km, PPZ to 500 km', () => {
    const rings = stackRings(karaikal, () => true);
    expect(rings.map(([p]) => p)).toEqual(['ppi', 'caz', 'ppz']);
    expect(rings.map(([, r]) => Math.round(r.innerKm))).toEqual([0, 149, 249]);
    expect(rings.map(([, r]) => r.outermost)).toEqual([false, false, true]);
    expect(stackPrimary(karaikal)).toBe('caz');
  });

  it('draws each picture only in its own ring, each circle inside the next', () => {
    const res = stack({ ppi: 1, caz: 2, ppz: 3 });
    expect(valueAt(res, ...eastOf(karaikal, 60))).toBeCloseTo(1, 1);
    expect(valueAt(res, ...eastOf(karaikal, 200))).toBeCloseTo(2, 1);
    expect(valueAt(res, ...eastOf(karaikal, 400))).toBeCloseTo(3, 1);
    // the PPI is a circle here: 170 km out on the diagonal is the CAZ's, not the PPI picture's corner
    expect(valueAt(res, karaikal.lat + 120 / 111.32, eastOf(karaikal, 120)[1])).toBeCloseTo(2, 1);
  });

  it('leaves no gap where two rings meet', () => {
    const res = stack({ ppi: 2, caz: 2, ppz: 2 });
    for (const km of [146, 148, 149.5, 150, 151, 246, 249, 250, 252]) expect([km, valueAt(res, ...eastOf(karaikal, km))]).toEqual([km, 2]);
  });

  it('gives a missing picture\'s ground to the ring around it', () => {
    const res = stack({ caz: 2, ppz: 3 });
    expect(valueAt(res, ...eastOf(karaikal, 60))).toBeCloseTo(2, 1);
    expect(valueAt(res, ...eastOf(karaikal, 400))).toBeCloseTo(3, 1);
  });

  it('keeps each picture\'s own scan time: the newest of them is the stack\'s', () => {
    const res = stack({ ppi: 1, caz: 2, ppz: 3 }, { ppi: 4, caz: 0, ppz: -6 });
    expect(res.timing?.epochMs).toBe(T0 + 4 * 60_000);
  });
});

describe('composeRadarMosaic', () => {
  it('gives each product its own range: PPZ reaches further than CAZ', () => {
    const caz = composeRadarMosaic(IMD_RADAR_STATIONS, [['karaikal', scan(karaikal, 'caz', 4.0)]], 0.5, 2800, 'caz')!;
    const ppz = composeRadarMosaic(IMD_RADAR_STATIONS, [['karaikal', scan(karaikal, 'ppz', 4.0)]], 0.5, 2800, 'ppz')!;
    // about 283 km away on the diagonal: beyond CAZ's range, inside PPZ's
    const diagonal: [number, number] = [karaikal.lat + 200 / 111.32, eastOf(karaikal, 200)[1]];
    expect(valueAt(caz, diagonal[0], diagonal[1])).toBe(0);
    expect(valueAt(ppz, diagonal[0], diagonal[1])).toBeCloseTo(4.0, 1);
  });

  it('keeps the corners of a PPI picture (a square), not only its circle', () => {
    const ppi = composeRadarMosaic(IMD_RADAR_STATIONS, [['karaikal', scan(karaikal, 'ppi', 4.0)]], 0.5, 2800, 'ppi')!;
    // 120 km north and 120 km east: 170 km out, beyond the 150 km circle but inside the square of the picture
    const corner: [number, number] = [karaikal.lat + 120 / 111.32, eastOf(karaikal, 120)[1]];
    expect(valueAt(ppi, corner[0], corner[1])).toBeCloseTo(4.0, 1);
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

/** How fully the composite is drawn at a place (0..1; 1 when it has no fade at all). */
function fadeAt(result: ProcessedRadarResult, lat: number, lng: number): number {
  if (!result.displayFade) return 1;
  const { cropW, cropH, bounds } = result.fieldData;
  const [[south, west], [north, east]] = bounds;
  const x = Math.round(((lng - west) / (east - west)) * (cropW - 1));
  const y = Math.round(((north - lat) / (north - south)) * (cropH - 1));
  return result.displayFade[y * cropW + x] / 255;
}

describe('older echoes where radars overlap', () => {
  const MIN = 60_000;

  it('overlapFade: in full within one scan, fainter one scan behind, faintest half an hour behind; less where the newer radar sees rain too', () => {
    expect(overlapFade(4, 0, 5 * MIN, 0, 1)).toBe(1);
    expect(overlapFade(4, 0, 10 * MIN, 0, 1)).toBeCloseTo(OVERLAP_FADE_ONE_SCAN, 5);
    expect(overlapFade(4, 0, 30 * MIN, 0, 1)).toBeCloseTo(OVERLAP_FADE_OLDEST, 5);
    expect(overlapFade(4, 0, 60 * MIN, 0, 1)).toBeCloseTo(OVERLAP_FADE_OLDEST, 5);
    expect(overlapFade(4, 0, 10 * MIN, 4, 1)).toBe(1); // the newer radar sees it as strong: it is still there
    expect(overlapFade(4, 0, 10 * MIN, 2, 1)).toBeGreaterThan(OVERLAP_FADE_ONE_SCAN);
    expect(overlapFade(4, 0, 10 * MIN, 0, 0)).toBe(1); // outside the newer radar's reach
    expect(overlapFade(4, 0, 10 * MIN, 0, 0.5)).toBeCloseTo(1 - (1 - OVERLAP_FADE_ONE_SCAN) / 2, 5); // eased in at its edge
  });

  it('draws everything in full when the radars scanned together', () => {
    const mosaic = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'caz', 4.0, 0)],
      ['chennai', scan(cni, 'caz', 0, 3)],
    ])!;
    expect(mosaic.displayFade).toBeUndefined();
  });

  it('fades the echo of a radar that scanned before another one that covers the same place and sees it dry', () => {
    const mosaic = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'caz', 4.0, -20)],
      ['chennai', scan(cni, 'caz', 0, 0)],
    ])!;
    const overlap = between(0.5);
    expect(valueAt(mosaic, ...overlap)).toBeCloseTo(4.0, 1); // the echo is still drawn, as strong as it was
    expect(fadeAt(mosaic, ...overlap)).toBeLessThan(OVERLAP_FADE_ONE_SCAN + 0.01);
    expect(fadeAt(mosaic, ...overlap)).toBeGreaterThan(OVERLAP_FADE_OLDEST - 0.01);
    // beyond Chennai's reach only Karaikal sees the place: drawn in full
    expect(fadeAt(mosaic, ...eastOf(karaikal, -150))).toBe(1);
  });

  it('keeps the echo of the newer radar in full, and of the older one too where the newer radar sees the same rain', () => {
    const newerKaraikal = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'caz', 4.0, 0)],
      ['chennai', scan(cni, 'caz', 0, -20)],
    ])!;
    expect(fadeAt(newerKaraikal, ...between(0.5))).toBe(1);
    const bothSeeIt = composeRadarMosaic(IMD_RADAR_STATIONS, [
      ['karaikal', scan(karaikal, 'caz', 4.0, -20)],
      ['chennai', scan(cni, 'caz', 4.0, 0)],
    ])!;
    expect(fadeAt(bothSeeIt, ...between(0.5))).toBe(1);
  });
});
