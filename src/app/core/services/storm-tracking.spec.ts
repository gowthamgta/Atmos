import { describe, expect, it } from 'vitest';
import {
  CONE_SPREAD,
  detectCells,
  displacementToMotion,
  estimateMotion,
  motionAt,
  offset,
  sampleToGrid,
  stormCone,
  trackingGrid,
  windToMotion,
} from './storm-tracking';

/** A blob of rain (Gaussian, peak `peak`) on an nx x ny grid. */
function blob(nx: number, ny: number, cx: number, cy: number, peak: number, sigma = 3): Float32Array {
  const g = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) g[y * nx + x] = peak * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma * sigma));
  return g;
}

function add(a: Float32Array, b: Float32Array): Float32Array {
  return a.map((v, i) => v + b[i]);
}

describe('detectCells', () => {
  it('finds a storm with a heavy core and ignores light rain', () => {
    const g = add(blob(60, 60, 20, 30, 4.5), blob(60, 60, 45, 15, 1.8, 6));
    const cells = detectCells(g, 60, 60);
    expect(cells).toHaveLength(1);
    expect(cells[0].x).toBeCloseTo(20.5, 0);
    expect(cells[0].y).toBeCloseTo(30.5, 0);
    expect(cells[0].peak).toBeGreaterThan(4.4);
    expect(cells[0].radius).toBeGreaterThan(1);
  });

  it('ignores specks smaller than the minimum area and returns the strongest first', () => {
    const g = new Float32Array(400);
    g[5 * 20 + 5] = 5; // a single hot pixel
    const storms = add(add(g, blob(20, 20, 14, 14, 3.4, 1.5)), blob(20, 20, 4, 15, 5, 1.5));
    const cells = detectCells(storms, 20, 20);
    expect(cells.every(c => c.area >= 3)).toBe(true);
    expect(cells[0].peak).toBeGreaterThan(cells.at(-1)!.peak - 1e-9);
  });
});

describe('estimateMotion', () => {
  it('recovers the shift of a rain pattern between two pictures', () => {
    const nx = 64;
    const ny = 64;
    const prev = add(blob(nx, ny, 26, 30, 3.5, 3), blob(nx, ny, 34, 26, 2.5, 2));
    const curr = add(blob(nx, ny, 30, 28, 3.5, 3), blob(nx, ny, 38, 24, 2.5, 2)); // moved 4 east, 2 north
    const vectors = estimateMotion(prev, curr, nx, ny, 8);
    expect(vectors.length).toBeGreaterThan(0);
    const m = motionAt(32, 28, vectors)!;
    expect(m.dx).toBeCloseTo(4, 0);
    expect(m.dy).toBeCloseTo(-2, 0);
  });

  it('gives no motion to rain that did not move, and no vectors where it is dry', () => {
    const g = blob(48, 48, 24, 24, 3.5, 3);
    const m = motionAt(24, 24, estimateMotion(g, g, 48, 48, 6))!;
    expect(Math.hypot(m.dx, m.dy)).toBeLessThan(0.5);
    expect(estimateMotion(new Float32Array(48 * 48), new Float32Array(48 * 48), 48, 48, 6)).toEqual([]);
    expect(motionAt(5, 5, [])).toBeNull();
  });
});

describe('motion and geometry', () => {
  const grid = trackingGrid(8, 74, 16, 82);

  it('turns a grid displacement into km/h and a heading', () => {
    // 5 cells east in 30 minutes at the equator-ish latitude: 5 * 0.036 * 111.2 km / 0.5 h
    const east = displacementToMotion(5, 0, 30, grid, 0);
    expect(east.speedKmh).toBeCloseTo((5 * 0.036 * 111.2) / 0.5, 6);
    expect(east.towardsDeg).toBeCloseTo(90, 6);
    expect(displacementToMotion(0, -3, 30, grid, 10).towardsDeg).toBeCloseTo(0, 6); // up the grid is north
    expect(displacementToMotion(0, 3, 30, grid, 10).towardsDeg).toBeCloseTo(180, 6);
  });

  it('moves storms with the steering wind, towards where it blows', () => {
    expect(windToMotion(0, -10).towardsDeg).toBeCloseTo(180, 6); // northerly wind pushes storms south
    expect(windToMotion(10, 0).towardsDeg).toBeCloseTo(90, 6);
    expect(windToMotion(3, 4).speedKmh).toBeCloseTo(18, 6);
  });

  it('builds a closed cone that starts at the storm and widens along its track', () => {
    const ring = stormCone(12, 78, 5, 30, 90);
    expect(ring[0]).toEqual(ring.at(-1));
    const lons = ring.map(p => p[0]);
    const lats = ring.map(p => p[1]);
    const [endLon] = offset(12, 78, 30, 90);
    expect(Math.max(...lons)).toBeGreaterThan(endLon); // the rounded front reaches past the hour's position
    expect(Math.min(...lons)).toBeLessThan(78); // and the back wraps around the storm itself
    const halfWidthEndKm = ((Math.max(...lats) - Math.min(...lats)) / 2) * 111.2;
    expect(halfWidthEndKm).toBeCloseTo(5 + CONE_SPREAD * 30, 0);
  });

  it('samples a lat/lon field onto the tracking grid, keeping the strongest value per cell', () => {
    const src = { field: new Float32Array(100), width: 10, height: 10, south: 10, west: 76, north: 11, east: 77 };
    src.field[5 * 10 + 5] = 4;
    const g = trackingGrid(10, 76, 11, 77, 0.25);
    const out = sampleToGrid(src, g);
    expect(out.length).toBe(16);
    expect(Math.max(...out)).toBe(4);
    expect(out.filter(v => v > 0).length).toBe(1);
  });
});
