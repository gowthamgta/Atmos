import { describe, expect, it } from 'vitest';
import { LIGHTNING_WINDOW_S, decodeStrokes, lightningGeoJson } from './lightning';

/** A response of the shape ILDN sends: [time f64, lat f32, lon f32, age f32, (4 bytes), id u64] per stroke. */
function response(strokes: { lat: number; lon: number; age: number }[]): ArrayBuffer {
  const buf = new ArrayBuffer(strokes.length * 32);
  const v = new DataView(buf);
  strokes.forEach((s, i) => {
    v.setFloat64(i * 32, 1_760_000_000 - s.age, true);
    v.setFloat32(i * 32 + 8, s.lat, true);
    v.setFloat32(i * 32 + 12, s.lon, true);
    v.setFloat32(i * 32 + 16, s.age, true);
    v.setBigUint64(i * 32 + 24, BigInt(i + 1), true);
  });
  return buf;
}

describe('lightning strokes', () => {
  it('reads latitude, longitude and age of every stroke', () => {
    const out = decodeStrokes(response([{ lat: 11.731, lon: 79.227, age: 12 }, { lat: 16.4, lon: 77.9, age: 250 }]));
    expect(out).toHaveLength(2);
    expect(out[0].lat).toBeCloseTo(11.731, 3);
    expect(out[0].lon).toBeCloseTo(79.227, 3);
    expect(out[1].ageS).toBeCloseTo(250, 1);
  });

  it('keeps only the last five minutes', () => {
    const out = decodeStrokes(response([{ lat: 10, lon: 78, age: 100 }, { lat: 10, lon: 78, age: LIGHTNING_WINDOW_S + 1 }, { lat: 10, lon: 78, age: 5000 }]));
    expect(out.map(s => Math.round(s.ageS))).toEqual([100]);
  });

  it('ignores records that are not places on Earth, and a trailing partial record', () => {
    const buf = response([{ lat: 95, lon: 78, age: 10 }, { lat: 12, lon: 78, age: 10 }]);
    const withTail = new Uint8Array(buf.byteLength + 7);
    withTail.set(new Uint8Array(buf));
    expect(decodeStrokes(withTail.buffer)).toHaveLength(1);
    expect(decodeStrokes(new ArrayBuffer(0))).toEqual([]);
  });

  it('makes map points in [longitude, latitude] order, with the age', () => {
    const f = lightningGeoJson([{ lat: 12, lon: 79, ageS: 30.4 }]);
    expect(f.features[0].geometry.coordinates).toEqual([79, 12]);
    expect(f.features[0].properties.age).toBe(30);
  });
});
