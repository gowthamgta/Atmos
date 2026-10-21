import { describe, it, expect } from 'vitest';
import { IMD_RADAR_STATIONS } from '../domain/models/radar.model';
import { inspectRadar, type RadarInspectInput } from './radar-inspector';
import type { RadarDisplayFrame } from './radar.service';

/** A 3 x 3 picture over Kallakurichi (about 133 km from Karaikal, 208 km from Chennai), every pixel the same byte. */
function frame(byte: number): RadarDisplayFrame {
  return {
    field: new Uint8Array(9).fill(byte),
    width: 3,
    height: 3,
    coordinates: [[78.9, 11.8], [79.0, 11.8], [79.0, 11.7], [78.9, 11.7]],
    timeMs: 0,
  };
}

function input(shown: RadarDisplayFrame | null, hidden: string[] = []): RadarInspectInput {
  return { shown, allResults: new Map(), stations: IMD_RADAR_STATIONS, hidden: new Set(hidden), unavailable: new Set(), product: 'caz' };
}

// one byte is 6/255 of intensity; dBZ = 12 + 9.6 x intensity
const byteFor = (dbz: number) => Math.round((((dbz - 12) / 9.6) * 255) / 6);

describe('radar inspector', () => {
  it('reads the echo under the pointer with each radar beam over the place', () => {
    const info = inspectRadar(input(frame(byteFor(40))), 11.75, 78.95, { x: 5, y: 6 })!;
    expect(info.dbz).toBe(40);
    expect(info.label).toBe('Heavy Rain (40 dBZ)');
    expect(info.x).toBe(5);
    expect(info.beams.map(b => b.name)).toEqual(['Karaikal', 'Chennai']);
  });

  it('calls a faint echo seen only from high up rain aloft', () => {
    // with Karaikal off, only Chennai's beam (about 4.4 km up) sees the place
    const info = inspectRadar(input(frame(byteFor(20)), ['karaikal']), 11.75, 78.95, { x: 0, y: 0 })!;
    expect(info.label).toBe('Rain aloft (20 dBZ): may not reach the ground');
  });

  it('shows the beam heights where there is no echo, and nothing outside every radar', () => {
    const empty = inspectRadar(input(frame(0)), 11.75, 78.95, { x: 0, y: 0 })!;
    expect(empty.dbz).toBeNull();
    expect(empty.label).toBe('No echo');
    expect(empty.beams.length).toBe(2);
    expect(inspectRadar(input(null), 20, 72, { x: 0, y: 0 })).toBeNull();
  });
});
