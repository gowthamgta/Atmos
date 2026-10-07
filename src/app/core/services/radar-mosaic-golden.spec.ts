import { describe, expect, it } from 'vitest';
import { IMD_RADAR_STATIONS, ProcessedRadarResult, RadarProductKey } from '../domain/models/radar.model';
import { composeRadarMosaic } from './radar-mosaic';

/** A deterministic, patchy intensity field like a radar's: blobs of rain with gaps, inside the dish. */
function blobs(seed: number, n = 256): Float32Array {
  const f = new Float32Array(n * n);
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const cells = Array.from({ length: 14 }, () => ({ x: rnd() * n, y: rnd() * n, r: 6 + rnd() * 30, v: 0.5 + rnd() * 4.5 }));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let v = 0;
    for (const c of cells) v = Math.max(v, c.v * Math.max(0, 1 - Math.hypot(x - c.x, y - c.y) / c.r));
    f[y * n + x] = v;
  }
  return f;
}

function scan(id: string, product: RadarProductKey, seed: number, minutes: number): ProcessedRadarResult {
  const st = IMD_RADAR_STATIONS.find(s => s.id === id)!;
  const config = st.products[product];
  const n = 256;
  return {
    stationId: id, dataUrl: '',
    fieldData: { field: blobs(seed, n), cropW: n, cropH: n, cx: n / 2, cy: n / 2, radius: n / 2, bounds: config.bounds },
    timing: { ist: '', utc: '', date: '', epochMs: Date.UTC(2026, 9, 5, 12, minutes) },
    coordinates: config.maplibreCoordinates, isDisplayed: true,
  };
}

function hash(a: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }): string {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let x = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) { x ^= u[i]; x = Math.imul(x, 0x01000193); }
  return (x >>> 0).toString(16);
}

describe('composeRadarMosaic: unchanged output on a fixed multi-station scene', () => {
  const sources: [string, ProcessedRadarResult][] = [
    ['karaikal', scan('karaikal', 'caz', 1, 0)], ['karaikal:ppz', scan('karaikal', 'ppz', 2, 3)],
    ['chennai', scan('chennai', 'caz', 3, 0)], ['chennai:ppz', scan('chennai', 'ppz', 4, 5)],
    ['thiruvananthapuram', scan('thiruvananthapuram', 'caz', 5, 1)], ['mangaluru', scan('mangaluru', 'caz', 6, 2)],
    ['sriharikota', scan('sriharikota', 'caz', 7, 0)],
  ];

  it('gives the same field, picture and corners', () => {
    const m = composeRadarMosaic(IMD_RADAR_STATIONS, sources, 0.5, 1400, 'caz')!;
    expect({ w: m.fieldData.cropW, h: m.fieldData.cropH, field: hash(m.fieldData.field), shown: hash(m.displayField!) }).toEqual({ w: 1400, h: 1400, field: 'd227136e', shown: 'e49fe9fc' })   // recorded from the implementation before the banded rewrite;
  });
});
