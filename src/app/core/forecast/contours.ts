import { ForecastGrid } from './forecast.model';

/** A contour as lon/lat points. `closed` lines end where they began. */
export interface ContourLine {
  level: number;
  points: [number, number][];
  closed: boolean;
}

/**
 * Smooths a field with repeated 3x3 binomial filtering, ignoring NaN neighbours. A little smoothing turns the
 * stair-stepped contours of a gridded field into the gentle curves isobars should have.
 */
export function smoothField(values: ArrayLike<number>, nx: number, ny: number, passes = 2): Float32Array {
  let src = Float32Array.from(values as ArrayLike<number> as number[]);
  let dst = new Float32Array(src.length);
  const w = [1, 2, 1];
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const centre = src[y * nx + x];
        if (Number.isNaN(centre)) {
          dst[y * nx + x] = NaN;
          continue;
        }
        let sum = 0;
        let wsum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= ny) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= nx) continue;
            const v = src[yy * nx + xx];
            if (Number.isNaN(v)) continue;
            const weight = w[dx + 1] * w[dy + 1];
            sum += v * weight;
            wsum += weight;
          }
        }
        dst[y * nx + x] = sum / wsum;
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

// Marching-squares case table. Corner bits: 1 = top-left, 2 = top-right, 4 = bottom-right, 8 = bottom-left (set when the
// value is >= the level). Edges: 0 = top, 1 = right, 2 = bottom, 3 = left. Each entry lists segments as edge pairs.
const CASES: readonly (readonly [number, number][])[] = [
  [], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], [[3, 0], [1, 2]] /* saddle: resolved below */, [[0, 2]], [[3, 2]],
  [[2, 3]], [[0, 2]], [[0, 1], [2, 3]] /* saddle: resolved below */, [[1, 2]], [[1, 3]], [[0, 1]], [[3, 0]], [],
];

/**
 * Contour lines of a regular lat/lon field (row 0 = north) at the given levels, joined into continuous polylines.
 * Cells with a missing (NaN) corner are skipped.
 */
export function contourLines(values: ArrayLike<number>, grid: ForecastGrid, levels: readonly number[]): ContourLine[] {
  const { nx, ny } = grid;
  const total = nx * ny;
  const out: ContourLine[] = [];

  // A cell edge is identified by one number: horizontal edge (y, x)-(y, x+1) is y*nx+x, vertical edge
  // (y, x)-(y+1, x) is total + y*nx+x. Neighbouring cells share an edge id, which is how segments are joined.
  const edgeId = (cx: number, cy: number, edge: number): number => {
    switch (edge) {
      case 0: return cy * nx + cx;                 // top
      case 1: return total + cy * nx + cx + 1;     // right
      case 2: return (cy + 1) * nx + cx;           // bottom
      default: return total + cy * nx + cx;        // left
    }
  };

  for (const level of levels) {
    const segs: [number, number][] = [];
    const adj = new Map<number, number[]>();
    const link = (id: number, seg: number) => {
      const list = adj.get(id);
      if (list) list.push(seg);
      else adj.set(id, [seg]);
    };

    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const tl = values[y * nx + x];
        const tr = values[y * nx + x + 1];
        const br = values[(y + 1) * nx + x + 1];
        const bl = values[(y + 1) * nx + x];
        if (tl !== tl || tr !== tr || br !== br || bl !== bl) continue; // NaN
        let idx = (tl >= level ? 1 : 0) | (tr >= level ? 2 : 0) | (br >= level ? 4 : 0) | (bl >= level ? 8 : 0);
        if (idx === 0 || idx === 15) continue;
        let pairs = CASES[idx];
        if (idx === 5 || idx === 10) {
          // saddle: the cell centre decides whether the high corners are joined
          const centreHigh = (tl + tr + br + bl) / 4 >= level;
          if (idx === 5) pairs = centreHigh ? [[3, 2], [1, 0]] : [[3, 0], [1, 2]];
          else pairs = centreHigh ? [[0, 3], [2, 1]] : [[0, 1], [2, 3]];
        }
        for (const [ea, eb] of pairs) {
          const seg = segs.length;
          const a = edgeId(x, y, ea);
          const b = edgeId(x, y, eb);
          segs.push([a, b]);
          link(a, seg);
          link(b, seg);
        }
      }
    }
    if (segs.length === 0) continue;

    const point = (id: number): [number, number] => {
      let gx: number;
      let gy: number;
      if (id < total) {
        const x = id % nx;
        const y = (id - x) / nx;
        const v0 = values[id];
        const v1 = values[id + 1];
        gx = x + (level - v0) / (v1 - v0);
        gy = y;
      } else {
        const k = id - total;
        const x = k % nx;
        const y = (k - x) / nx;
        const v0 = values[k];
        const v1 = values[k + nx];
        gx = x;
        gy = y + (level - v0) / (v1 - v0);
      }
      return [grid.lonMin + gx * grid.step, grid.latMax - gy * grid.step];
    };

    const used = new Uint8Array(segs.length);
    const extend = (chain: number[], atEnd: boolean): void => {
      for (;;) {
        const tip = atEnd ? chain[chain.length - 1] : chain[0];
        const next = adj.get(tip)?.find(s => !used[s]);
        if (next === undefined) return;
        used[next] = 1;
        const [a, b] = segs[next];
        const other = a === tip ? b : a;
        if (atEnd) chain.push(other);
        else chain.unshift(other);
      }
    };

    for (let s = 0; s < segs.length; s++) {
      if (used[s]) continue;
      used[s] = 1;
      const chain = [segs[s][0], segs[s][1]];
      extend(chain, true);
      extend(chain, false);
      out.push({ level, points: chain.map(point), closed: chain.length > 2 && chain[0] === chain[chain.length - 1] });
    }
  }
  return out;
}

/** Levels at every `step` between the field's minimum and maximum (multiples of `step`). */
export function contourLevels(values: ArrayLike<number>, step: number): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === v) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min)) return [];
  const levels: number[] = [];
  for (let l = Math.ceil(min / step) * step; l <= max; l += step) levels.push(l);
  return levels;
}

export interface IsobarCollection {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: { level: number; label: string; major: boolean };
    geometry: { type: 'LineString'; coordinates: [number, number][] };
  }[];
}

/** GeoJSON isobars for a mean-sea-level pressure field in hPa: a line every `step` hPa, every 10 hPa emphasised. */
export function isobarGeoJson(msl: ArrayLike<number>, grid: ForecastGrid, step = 2): IsobarCollection {
  const field = smoothField(msl, grid.nx, grid.ny, 2);
  const lines = contourLines(field, grid, contourLevels(field, step));
  return {
    type: 'FeatureCollection',
    features: lines
      .filter(l => l.points.length >= 3)
      .map(l => ({
        type: 'Feature' as const,
        properties: { level: l.level, label: String(Math.round(l.level)), major: Math.round(l.level) % 10 === 0 },
        geometry: { type: 'LineString' as const, coordinates: l.points },
      })),
  };
}
