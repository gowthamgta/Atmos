import { MOTION_BLOCK, MotionVector, TrackingGrid, motionAt } from './storm-tracking';

/**
 * The motion of the rain over the whole radar picture, as a smooth field: how many degrees east and north it moves in an hour at each node of
 * a coarse lattice. It comes from the block-matching vectors of two radar pictures (storm-tracking.ts), or from one steering wind where the
 * radar gives none. Used to slide the picture forward (the nowcast) and to say when rain will reach a place.
 */
export interface MotionField {
  west: number;
  north: number;
  /** Degrees between nodes (the same both ways): node (i, j) is at longitude west + i * step and latitude north - j * step. */
  step: number;
  nx: number;
  ny: number;
  /** Degrees per hour towards the east, and towards the north, at each node (row 0 at the north edge). */
  u: Float32Array;
  v: Float32Array;
}

export interface MotionBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

const KM_PER_DEG = 111.32;
/** Spacing of the lattice, about 28 km: the block-matching vectors are 32 km apart at best. */
export const MOTION_NODE_DEG = 0.25;

function emptyField(box: MotionBox, step: number): MotionField {
  const nx = Math.max(2, Math.ceil((box.east - box.west) / step) + 1);
  const ny = Math.max(2, Math.ceil((box.north - box.south) / step) + 1);
  return { west: box.west, north: box.north, step, nx, ny, u: new Float32Array(nx * ny), v: new Float32Array(nx * ny) };
}

/** The same motion everywhere (degrees per hour east and north). */
export function uniformMotionField(box: MotionBox, uDegPerHour: number, vDegPerHour: number, step = MOTION_NODE_DEG): MotionField {
  const f = emptyField(box, step);
  f.u.fill(uDegPerHour);
  f.v.fill(vDegPerHour);
  return f;
}

/** A motion towards `towardsDeg` (compass degrees) at `kmh`, as degrees per hour east and north at latitude `lat`. */
export function kmhToDegPerHour(kmh: number, towardsDeg: number, lat: number): { u: number; v: number } {
  const a = (towardsDeg * Math.PI) / 180;
  return { u: (kmh * Math.sin(a)) / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180)), v: (kmh * Math.cos(a)) / KM_PER_DEG };
}

/**
 * The motion field from block-matching vectors found between two pictures `minutes` apart on `grid` (the vectors are displacements in grid cells,
 * east and south positive). A node takes the quality-weighted mean of the vectors around it; a node with none around takes the mean of all of them,
 * so the rain moves the way the rest of it does. Null when there are no vectors at all.
 */
export function motionFieldFromVectors(vectors: readonly MotionVector[], grid: TrackingGrid, minutes: number, box: MotionBox, step = MOTION_NODE_DEG): MotionField | null {
  if (vectors.length === 0 || minutes <= 0) return null;
  const perHour = 60 / minutes;
  const toU = (dx: number) => dx * grid.step * perHour;
  const toV = (dy: number) => -dy * grid.step * perHour;
  let sw = 0;
  let su = 0;
  let sv = 0;
  for (const m of vectors) {
    sw += m.quality;
    su += m.quality * m.dx;
    sv += m.quality * m.dy;
  }
  const meanU = toU(su / sw);
  const meanV = toV(sv / sw);

  const f = emptyField(box, step);
  for (let j = 0; j < f.ny; j++) {
    const lat = f.north - j * step;
    const y = (grid.north - lat) / grid.step;
    for (let i = 0; i < f.nx; i++) {
      const lon = f.west + i * step;
      const x = (lon - grid.west) / grid.step;
      const m = motionAt(x, y, vectors, 2 * MOTION_BLOCK);
      f.u[j * f.nx + i] = m ? toU(m.dx) : meanU;
      f.v[j * f.nx + i] = m ? toV(m.dy) : meanV;
    }
  }
  smoothNodes(f);
  return f;
}

/** One pass of a 3 x 3 mean over the nodes, so a vector's neighbourhood blends into the next instead of stepping. */
function smoothNodes(f: MotionField): void {
  const u = new Float32Array(f.u);
  const v = new Float32Array(f.v);
  for (let j = 0; j < f.ny; j++) {
    for (let i = 0; i < f.nx; i++) {
      let su = 0;
      let sv = 0;
      let n = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const jj = j + dj;
          const ii = i + di;
          if (jj < 0 || ii < 0 || jj >= f.ny || ii >= f.nx) continue;
          su += u[jj * f.nx + ii];
          sv += v[jj * f.nx + ii];
          n++;
        }
      }
      f.u[j * f.nx + i] = su / n;
      f.v[j * f.nx + i] = sv / n;
    }
  }
}

/** The motion at a point (degrees per hour east and north): bilinear between the nodes, and the edge node's beyond the lattice. */
export function motionAtPoint(f: MotionField, lat: number, lon: number, out: { u: number; v: number } = { u: 0, v: 0 }): { u: number; v: number } {
  const fx = Math.min(Math.max((lon - f.west) / f.step, 0), f.nx - 1);
  const fy = Math.min(Math.max((f.north - lat) / f.step, 0), f.ny - 1);
  const i0 = Math.min(Math.floor(fx), f.nx - 2);
  const j0 = Math.min(Math.floor(fy), f.ny - 2);
  const tx = fx - i0;
  const ty = fy - j0;
  const a = j0 * f.nx + i0;
  const b = a + 1;
  const c = a + f.nx;
  const d = c + 1;
  out.u = (f.u[a] * (1 - tx) + f.u[b] * tx) * (1 - ty) + (f.u[c] * (1 - tx) + f.u[d] * tx) * ty;
  out.v = (f.v[a] * (1 - tx) + f.v[b] * tx) * (1 - ty) + (f.v[c] * (1 - tx) + f.v[d] * tx) * ty;
  return out;
}

/** Speed (km/h) and the compass direction it moves towards, from a motion in degrees per hour at latitude `lat`. */
export function motionToKmh(u: number, v: number, lat: number): { speedKmh: number; towardsDeg: number } {
  const east = u * KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const north = v * KM_PER_DEG;
  return { speedKmh: Math.hypot(east, north), towardsDeg: (Math.atan2(east, north) * 180 / Math.PI + 360) % 360 };
}
