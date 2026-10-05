import { describe, expect, it } from 'vitest';
import { contourLevels, contourLines, isobarGeoJson, smoothField } from './contours';
import { ForecastGrid } from './forecast.model';

const grid = (nx: number, ny: number, step = 1): ForecastGrid => ({
  latMax: 10 + (ny - 1) * step, latMin: 10, lonMin: 70, lonMax: 70 + (nx - 1) * step, step, nx, ny,
});

/** value(x, y) over a grid, row 0 first. */
function field(g: ForecastGrid, f: (x: number, y: number) => number): Float32Array {
  const out = new Float32Array(g.nx * g.ny);
  for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) out[y * g.nx + x] = f(x, y);
  return out;
}

describe('contourLines', () => {
  it('draws one straight line across a left-to-right ramp, at the right longitude', () => {
    const g = grid(11, 8);
    const v = field(g, x => x * 10); // 0..100 across the columns
    const lines = contourLines(v, g, [35]);
    expect(lines).toHaveLength(1);
    expect(lines[0].closed).toBe(false);
    expect(lines[0].points).toHaveLength(8); // one crossing per row
    for (const [lon] of lines[0].points) expect(lon).toBeCloseTo(70 + 3.5, 9); // 35 is 3.5 columns in
    const lats = lines[0].points.map(p => p[1]);
    expect(Math.max(...lats) - Math.min(...lats)).toBeCloseTo(7, 9); // spans the whole height
  });

  it('closes a ring around a hill and a hollow, with every point on the level', () => {
    const g = grid(31, 31);
    const hill = field(g, (x, y) => 100 - Math.hypot(x - 15, y - 15));
    const lines = contourLines(hill, g, [90]);
    expect(lines).toHaveLength(1);
    expect(lines[0].closed).toBe(true);
    for (const [lon, lat] of lines[0].points) {
      const r = Math.hypot(lon - 70 - 15, 10 + 30 - lat - 15); // grid x = lon - 70, grid y = latMax - lat
      expect(r).toBeCloseTo(10, 0); // radius 10 cells (linear interpolation of a cone is exact on rays)
    }
  });

  it('joins segments into long lines instead of leaving thousands of 2-point pieces', () => {
    const g = grid(40, 30);
    const v = field(g, (x, y) => 50 + 10 * Math.sin(x / 6) + 8 * Math.cos(y / 5));
    const lines = contourLines(v, g, [50, 56]);
    const longest = Math.max(...lines.map(l => l.points.length));
    expect(longest).toBeGreaterThan(20);
    expect(lines.every(l => l.points.length >= 2)).toBe(true);
  });

  it('skips cells with missing data', () => {
    const g = grid(11, 8);
    const v = field(g, x => x * 10);
    for (let y = 0; y < g.ny; y++) v[y * g.nx + 3] = NaN; // a missing column where the contour would cross
    expect(contourLines(v, g, [35])).toHaveLength(0);
  });

  it('resolves a saddle by the cell centre, so lines never cross', () => {
    const g = grid(2, 2); // one cell: top-left and bottom-right high (10), the other two low (0); centre average 5
    const v = Float32Array.from([10, 0, 0, 10]);
    const at = (lines: ReturnType<typeof contourLines>) =>
      lines.map(l => l.points.map(([lon, lat]) => [+(lon - 70).toFixed(2), +(11 - lat).toFixed(2)]));

    // level 4: the centre (5) is above it, so the high corners are joined and the two LOW corners are cut off
    const joined = at(contourLines(v, g, [4]));
    expect(joined).toHaveLength(2);
    expect(joined).toContainEqual(expect.arrayContaining([[0.6, 0], [1, 0.4]])); // cuts off the top-right corner
    expect(joined).toContainEqual(expect.arrayContaining([[0.4, 1], [0, 0.6]])); // cuts off the bottom-left corner

    // level 6: the centre is below it, so the high corners are separate and each one is cut off
    const separate = at(contourLines(v, g, [6]));
    expect(separate).toHaveLength(2);
    expect(separate).toContainEqual(expect.arrayContaining([[0.4, 0], [0, 0.4]])); // cuts off the top-left corner
    expect(separate).toContainEqual(expect.arrayContaining([[1, 0.6], [0.6, 1]])); // cuts off the bottom-right corner
  });

  it('joins the four cell segments around a single high point into one closed ring', () => {
    const g = grid(3, 3);
    const v = Float32Array.from([0, 0, 0, 0, 10, 0, 0, 0, 0]);
    const lines = contourLines(v, g, [5]);
    expect(lines).toHaveLength(1);
    expect(lines[0].closed).toBe(true);
    expect(lines[0].points).toHaveLength(5); // 4 segments, first point repeated at the end
  });

  it('is empty when the level is outside the data range', () => {
    const g = grid(5, 5);
    expect(contourLines(field(g, x => x), g, [100])).toEqual([]);
  });
});

describe('contourLevels', () => {
  it('lists multiples of the step inside the data range', () => {
    expect(contourLevels(Float32Array.from([1003.2, 1011.9, NaN]), 2)).toEqual([1004, 1006, 1008, 1010]);
    expect(contourLevels(Float32Array.from([NaN]), 2)).toEqual([]);
  });
});

describe('smoothField', () => {
  it('keeps a constant field constant and softens a spike', () => {
    expect(Array.from(smoothField(new Float32Array(25).fill(7), 5, 5))).toEqual(new Array(25).fill(7));
    const spike = new Float32Array(25);
    spike[12] = 16;
    const s = smoothField(spike, 5, 5, 1);
    expect(s[12]).toBeCloseTo(4, 6); // centre weight 4/16 of 16
    expect(s[11]).toBeCloseTo(2, 6);
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(16, 4); // smoothing conserves the total away from the edges
  });

  it('ignores missing neighbours', () => {
    const f = Float32Array.from([1, 1, 1, 1, 1, NaN, 1, 1, 1]);
    const s = smoothField(f, 3, 3, 1);
    expect(s[5]).toBeNaN();
    expect(s[4]).toBeCloseTo(1, 6);
  });
});

describe('isobarGeoJson', () => {
  it('labels lines in hPa, emphasising every 10 hPa', () => {
    const g = grid(41, 21, 0.5);
    const msl = field(g, x => 1000 + x * 0.5); // 1000 to 1020 hPa across the area
    const fc = isobarGeoJson(msl, g, 2);
    const levels = new Set(fc.features.map(f => f.properties.level));
    expect([...levels].sort()).toEqual([1002, 1004, 1006, 1008, 1010, 1012, 1014, 1016, 1018]);
    for (const f of fc.features) {
      expect(f.properties.label).toBe(String(f.properties.level));
      expect(f.properties.major).toBe(f.properties.level % 10 === 0);
      expect(f.geometry.type).toBe('LineString');
    }
    expect(fc.features.find(f => f.properties.level === 1010)!.properties.major).toBe(true);
  });

  it('contours a full-size domain field fast enough to redo on every time step', () => {
    const g: ForecastGrid = { latMax: 22, latMin: 4, lonMin: 68, lonMax: 90, step: 0.1, nx: 221, ny: 181 };
    // pressure-like field: a broad gradient with a few lows and ridges, 960 to 1030 hPa
    const msl = new Float32Array(g.nx * g.ny);
    for (let y = 0; y < g.ny; y++) {
      for (let x = 0; x < g.nx; x++) {
        msl[y * g.nx + x] = 1008 + 8 * Math.sin(x / 25) * Math.cos(y / 20) + 5 * Math.sin((x + y) / 14) + 20 * Math.exp(-(((x - 150) ** 2 + (y - 90) ** 2) / 600));
      }
    }
    isobarGeoJson(msl, g, 2); // warm up
    const t0 = performance.now();
    const runs = 10;
    let features = 0;
    for (let i = 0; i < runs; i++) features = isobarGeoJson(msl, g, 2).features.length;
    const ms = (performance.now() - t0) / runs;
    console.info(`isobars: ${features} lines in ${ms.toFixed(1)} ms per update`);
    expect(features).toBeGreaterThan(10);
    expect(ms).toBeLessThan(60);
  });
});
