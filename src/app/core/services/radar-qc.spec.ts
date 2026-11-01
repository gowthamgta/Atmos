import { describe, expect, it } from 'vitest';
import { CLEAR_SKY_K, buildCloudMap, isClearSky, productClearShare, productLooksWrong, removeClearPatches } from './radar-qc';
import { removeRadialSpikes } from './radar-process';
import { stackRings } from './radar.service';
import { IMD_RADAR_STATIONS } from '../domain/models/radar.model';

// a satellite grid of 100 x 100 over 70-80 E, 5-15 N (Mercator rows; a degree is about 10 pixels, 11 km a pixel): clear sky (300 K) with a
// cloud (220 K) over 75-77 E, 9-11 N
const box = { west: 70, east: 80, south: 5, north: 15 };
const mercY = (lat: number) => 0.5 - Math.log((1 + Math.sin((lat * Math.PI) / 180)) / (1 - Math.sin((lat * Math.PI) / 180))) / (4 * Math.PI);
const frame = () => {
  const t = new Float32Array(100 * 100);
  for (let y = 0; y < 100; y++) {
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * (mercY(15) + ((y + 0.5) / 100) * (mercY(5) - mercY(15)))))) * 180) / Math.PI;
    for (let x = 0; x < 100; x++) {
      const lon = 70 + ((x + 0.5) / 100) * 10;
      t[y * 100 + x] = lon > 75 && lon < 77 && lat > 9 && lat < 11 ? 220 : 300;
    }
  }
  return t;
};
const map = buildCloudMap([frame()], 100, 100, box, 11, 10);

describe('the radar against the satellite', () => {
  it('knows clear sky from cloud, a little way round a cloud included', () => {
    expect(isClearSky(map, 13, 72)).toBe(true);
    expect(isClearSky(map, 10, 76)).toBe(false);
    expect(isClearSky(map, 10, 77.05)).toBe(false); // within 10 km of the cloud
    expect(isClearSky(map, 20, 76)).toBe(false); // outside the map: not known, so not clear
    expect(CLEAR_SKY_K).toBeLessThan(290);
  });

  it('removes a patch of echo only when all of it is under a clear sky', () => {
    // a field over the same box, 200 x 200: a speck under clear sky, a band that reaches from clear sky into the cloud
    const grid = { width: 200, height: 200, ...box };
    const f = new Float32Array(200 * 200);
    const at = (lat: number, lon: number) => Math.floor(((15 - lat) / 10) * 200) * 200 + Math.floor(((lon - 70) / 10) * 200);
    f[at(13, 72)] = 2;
    for (let lon = 73; lon <= 76; lon += 0.05) f[at(10, lon)] = 1.5;
    const bytes = Uint8Array.from(f, v => (v > 0 ? 100 : 0));
    const removed = removeClearPatches([f, bytes], grid, map);
    expect(removed).toBe(1);
    expect(f[at(13, 72)]).toBe(0);
    expect(bytes[at(13, 72)]).toBe(0);
    expect(f[at(10, 73)]).toBeGreaterThan(0); // the band's clear end stays: the band touches cloud
  });

  it('takes a product whose echo is mostly under a clear sky for misread or stale', () => {
    const grid = { width: 200, height: 200, ...box };
    const clear = new Float32Array(200 * 200);
    for (let i = 0; i < 6000; i++) clear[(i % 60) + 20 + Math.floor(i / 60) * 200] = 1; // a block around 13.5-14.5 N, 71-74 E: clear sky
    expect(productLooksWrong(productClearShare(clear, grid, map, 1))).toBe(true);
    const cloudy = new Float32Array(200 * 200);
    for (let y = 85; y < 115; y++) for (let x = 105; x < 135; x++) cloudy[y * 200 + x] = 1; // under the cloud
    expect(productLooksWrong(productClearShare(cloudy, grid, map, 1))).toBe(false);
  });
});

describe('radial interference spikes', () => {
  const size = 512, rangeKm = 250, kmPerPx = rangeKm / (size / 2);
  const polarSet = (f: Float32Array, deg: number, fromKm: number, toKm: number, halfWidthKm: number, v: number) => {
    const a = (deg * Math.PI) / 180;
    for (let km = fromKm; km <= toKm; km += kmPerPx / 2) {
      for (let w = -halfWidthKm; w <= halfWidthKm; w += kmPerPx / 2) {
        const x = Math.round(size / 2 + (km * Math.cos(a) - w * Math.sin(a)) / kmPerPx), y = Math.round(size / 2 + (km * Math.sin(a) + w * Math.cos(a)) / kmPerPx);
        if (x >= 0 && y >= 0 && x < size && y < size) f[y * size + x] = v;
      }
    }
  };

  it('clears a thin weak line along one ray, a dotted one too', () => {
    const f = new Float32Array(size * size);
    polarSet(f, 30, 40, 200, 1, 1);
    for (let km = 40; km < 200; km += 14) polarSet(f, 120, km, km + 6, 1.5, 1); // dotted: 6 km pieces, 8 km apart
    const before = f.filter(v => v > 0).length;
    removeRadialSpikes(f, size, rangeKm);
    // nearly all of it (a few pixels of the inner end may stay: there the line spans more degrees)
    expect(f.filter(v => v > 0).length).toBeLessThan(0.1 * before);
  });

  it('keeps rain: a wide cell, a band pointing at the radar that is wider than a ray, and a strong narrow line', () => {
    const f = new Float32Array(size * size);
    polarSet(f, 200, 60, 90, 15, 1.5); // a cell 30 km across
    polarSet(f, 300, 30, 120, 6, 1.5); // a band 12 km wide pointing at the radar
    polarSet(f, 80, 50, 150, 1, 3); // a narrow line with 41 dBZ in it
    const before = f.filter(v => v > 0).length;
    removeRadialSpikes(f, size, rangeKm);
    expect(f.filter(v => v > 0).length).toBe(before);
  });
});

describe("a station's stack (the owner's order: PPI inside, CAZ around it, PPZ outside)", () => {
  const karaikal = IMD_RADAR_STATIONS.find(s => s.id === 'karaikal')!;

  it('fills a missing ring from the next product out, and shows nothing when every product is too old', () => {
    expect(stackRings(karaikal, () => true).map(([p]) => p)).toEqual(['ppi', 'caz', 'ppz']);
    expect(stackRings(karaikal, p => p !== 'caz').map(([p, r]) => [p, r.innerKm > 0])).toEqual([['ppi', false], ['ppz', true]]);
    expect(stackRings(karaikal, p => p !== 'ppi').map(([p, r]) => [p, r.innerKm])).toEqual([['caz', 0], ['ppz', expect.any(Number)]]);
    expect(stackRings(karaikal, p => p === 'ppz').map(([p, r]) => [p, r.innerKm])).toEqual([['ppz', 0]]);
    expect(stackRings(karaikal, () => false)).toEqual([]);
  });

  it('keeps the CAZ where a PPZ reaches less far than it (Hyderabad)', () => {
    const station = { ...karaikal, products: { ...karaikal.products, ppz: { ...karaikal.products.ppz, rangeKm: 150 } } };
    expect(stackRings(station, () => true).map(([p]) => p)).toEqual(['ppi', 'caz']);
  });
});
