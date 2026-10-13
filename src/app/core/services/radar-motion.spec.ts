import { describe, expect, it } from 'vitest';
import { kmhToDegPerHour, motionAtPoint, motionFieldFromVectors, motionToKmh, uniformMotionField } from './radar-motion';
import { MotionVector, TrackingGrid } from './storm-tracking';

const GRID: TrackingGrid = { west: 77, north: 12, step: 0.036, nx: 200, ny: 200 };
const BOX = { south: 12 - 200 * 0.036, west: 77, north: 12, east: 77 + 200 * 0.036 };

describe('motion in degrees per hour', () => {
  it('turns a speed and direction into degrees east and north, and back', () => {
    const { u, v } = kmhToDegPerHour(36, 90, 10);                       // 36 km/h towards the east at 10 N
    expect(u).toBeCloseTo(36 / (111.32 * Math.cos((10 * Math.PI) / 180)), 6);
    expect(Math.abs(v)).toBeLessThan(1e-9);
    const back = motionToKmh(u, v, 10);
    expect(back.speedKmh).toBeCloseTo(36, 6);
    expect(back.towardsDeg).toBeCloseTo(90, 6);
    expect(motionToKmh(0, 0.5, 10).towardsDeg).toBeCloseTo(0, 6);      // towards the north
    expect(motionToKmh(-0.3, -0.3, 10).towardsDeg).toBeGreaterThan(180); // towards the south-west
  });

  it('is the same everywhere for a uniform field, also beyond the lattice', () => {
    const f = uniformMotionField(BOX, 0.3, -0.1);
    for (const [lat, lon] of [[11, 78], [5, 70], [20, 90]]) {
      const m = motionAtPoint(f, lat, lon);
      expect(m.u).toBeCloseTo(0.3, 6);
      expect(m.v).toBeCloseTo(-0.1, 6);
    }
  });

  it('interpolates between the nodes', () => {
    const f = uniformMotionField({ south: 10, west: 78, north: 11, east: 79 }, 0, 0, 0.5);
    f.u[0] = 1;                                                           // the north-west node only
    expect(motionAtPoint(f, 11, 78).u).toBeCloseTo(1, 6);
    expect(motionAtPoint(f, 11, 78.25).u).toBeCloseTo(0.5, 6);
    expect(motionAtPoint(f, 10.5, 78.5).u).toBeCloseTo(0, 6);
  });
});

describe('the motion field from block-matching vectors', () => {
  const vec = (x: number, y: number, dx: number, dy: number): MotionVector => ({ x, y, dx, dy, quality: 0.9 });

  it('gives nothing when no rain could be followed', () => {
    expect(motionFieldFromVectors([], GRID, 30, BOX)).toBeNull();
    expect(motionFieldFromVectors([vec(50, 50, 1, 1)], GRID, 0, BOX)).toBeNull();
  });

  it('converts a displacement over the interval to degrees per hour (east and north positive)', () => {
    // 5 cells east and 2 cells north (north is up the grid: dy -2) in 30 minutes
    const f = motionFieldFromVectors([vec(100, 100, 5, -2)], GRID, 30, BOX)!;
    const m = motionAtPoint(f, 12 - 100 * 0.036, 77 + 100 * 0.036);
    expect(m.u).toBeCloseTo(5 * 0.036 * 2, 6);
    expect(m.v).toBeCloseTo(2 * 0.036 * 2, 6);
  });

  it('follows the vectors around a place and the mean of them all far from any', () => {
    // two storms far apart (more than 2 blocks, 32 cells): one moves east, the other north
    const f = motionFieldFromVectors([vec(30, 100, 4, 0), vec(170, 100, 0, -4)], GRID, 30, BOX)!;
    const west = motionAtPoint(f, 12 - 100 * 0.036, 77 + 30 * 0.036);
    const east = motionAtPoint(f, 12 - 100 * 0.036, 77 + 170 * 0.036);
    expect(west.u).toBeGreaterThan(0.2);
    expect(Math.abs(west.v)).toBeLessThan(0.1);
    expect(east.v).toBeGreaterThan(0.2);
    expect(Math.abs(east.u)).toBeLessThan(0.1);
    // far from both, in the middle of the box and a long way north: the mean of the two (half of each)
    const far = motionAtPoint(f, 12 - 190 * 0.036, 77 + 100 * 0.036);
    expect(far.u).toBeCloseTo(0.144, 1);
    expect(far.v).toBeCloseTo(0.144, 1);
  });
});
