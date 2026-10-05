/**
 * Storm cells and where they are heading, from the radar mosaic.
 *
 *  1. The mosaic is sampled onto a fixed ~4 km tracking grid (the same grid for every time, whatever radars were up).
 *  2. Cells are connected areas of moderate rain or more that contain a heavy core (>= ~36 dBZ).
 *  3. Motion comes from pattern matching between two mosaics about half an hour apart (TREC, the classic radar
 *     nowcasting method): each 64 km block of the newer picture is compared with shifted copies of the older one,
 *     and the best-matching shift is that block's motion.
 *  4. Each cell moves with the motion around it (or, without history, with the forecast steering wind), and its
 *     next hour is drawn as a cone that widens with time for the uncertainty in speed and direction.
 */

/** Intensity scale of the radar field (see RADAR_COLOR_STOPS): 1.2 light rain, 2.0 moderate, 3.0 heavy (36+ dBZ). */
export const CELL_EDGE = 2.0;
export const CELL_CORE = 3.0;
export const MOTION_ECHO = 1.2;
/** Tracking grid spacing in degrees (~4 km). */
export const TRACK_STEP_DEG = 0.036;
/** Smallest cell, in tracking cells (3 x 16 km^2, about 50 km^2). */
export const MIN_CELL_AREA = 3;
/** Motion block size, in tracking cells (16 x 4 km = 64 km). */
export const MOTION_BLOCK = 16;
/** Fastest storm motion considered (km/h). */
export const MAX_STORM_SPEED_KMH = 80;
/** A block's match must correlate at least this well to count. */
export const MIN_MATCH_QUALITY = 0.5;
/** Cone: how far ahead (min), and how fast it widens (direction uncertainty, ~20 degrees each side). */
export const CONE_MINUTES = 60;
export const CONE_SPREAD = 0.36;

const KM_PER_DEG = 111.2;

export interface TrackingGrid {
  west: number;
  north: number;
  step: number;
  nx: number;
  ny: number;
}

/** A field on a lat/lon box (row 0 = north, rows and columns evenly spaced in degrees), like the radar mosaic. */
export interface LatLonField {
  field: Float32Array;
  width: number;
  height: number;
  south: number;
  west: number;
  north: number;
  east: number;
}

export function trackingGrid(south: number, west: number, north: number, east: number, step = TRACK_STEP_DEG): TrackingGrid {
  return { west, north, step, nx: Math.ceil((east - west) / step), ny: Math.ceil((north - south) / step) };
}

/** Strongest value of the field within each tracking cell (sampled at four points per cell); 0 outside the field. */
export function sampleToGrid(src: LatLonField, grid: TrackingGrid): Float32Array {
  const out = new Float32Array(grid.nx * grid.ny);
  const sx = (src.width - 1) / (src.east - src.west);
  const sy = (src.height - 1) / (src.north - src.south);
  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      let best = 0;
      for (let k = 0; k < 4; k++) {
        const lon = grid.west + (i + 0.25 + 0.5 * (k & 1)) * grid.step;
        const lat = grid.north - (j + 0.25 + 0.5 * (k >> 1)) * grid.step;
        if (lon < src.west || lon > src.east || lat < src.south || lat > src.north) continue;
        const v = src.field[Math.round((src.north - lat) * sy) * src.width + Math.round((lon - src.west) * sx)];
        if (v > best) best = v;
      }
      out[j * grid.nx + i] = best;
    }
  }
  return out;
}

export interface StormCell {
  /** Intensity-weighted centre, in tracking-grid cells (fractional). */
  x: number;
  y: number;
  /** Area in tracking cells, and the equivalent radius in cells. */
  area: number;
  radius: number;
  /** Strongest intensity in the cell. */
  peak: number;
}

/** Connected areas at or above `edge` that contain a core at or above `core` and are at least `minArea` cells. */
export function detectCells(g: Float32Array, nx: number, ny: number, edge = CELL_EDGE, core = CELL_CORE, minArea = MIN_CELL_AREA): StormCell[] {
  const seen = new Uint8Array(g.length);
  const stack = new Int32Array(g.length);
  const cells: StormCell[] = [];
  for (let start = 0; start < g.length; start++) {
    if (seen[start] || g[start] < edge) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let area = 0;
    let peak = 0;
    let wsum = 0;
    let xs = 0;
    let ys = 0;
    while (top > 0) {
      const c = stack[--top];
      const x = c % nx;
      const y = (c - x) / nx;
      const v = g[c];
      area++;
      if (v > peak) peak = v;
      wsum += v;
      xs += v * (x + 0.5);
      ys += v * (y + 0.5);
      for (let k = 0; k < 4; k++) {
        const ax = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ay = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (ax < 0 || ay < 0 || ax >= nx || ay >= ny) continue;
        const n = ay * nx + ax;
        if (!seen[n] && g[n] >= edge) {
          seen[n] = 1;
          stack[top++] = n;
        }
      }
    }
    if (peak >= core && area >= minArea) cells.push({ x: xs / wsum, y: ys / wsum, area, radius: Math.sqrt(area / Math.PI), peak });
  }
  return cells.sort((a, b) => b.peak - a.peak || b.area - a.area);
}

export interface MotionVector {
  /** Block centre, in tracking cells. */
  x: number;
  y: number;
  /** Displacement over the interval, in tracking cells (east and south positive, like the grid). */
  dx: number;
  dy: number;
  /** Correlation of the best match (0..1). */
  quality: number;
}

/**
 * Block-matching motion between two grids (`prev` older, `curr` newer). For every block of `curr` with enough rain,
 * finds the shift (up to `maxShift` cells) at which `prev` correlates best, i.e. where the block's rain came from.
 */
export function estimateMotion(
  prev: Float32Array,
  curr: Float32Array,
  nx: number,
  ny: number,
  maxShift: number,
  block = MOTION_BLOCK,
): MotionVector[] {
  const vectors: MotionVector[] = [];
  const n = block * block;
  for (let by = 0; by + block <= ny; by += block / 2) {
    for (let bx = 0; bx + block <= nx; bx += block / 2) {
      let wet = 0;
      let meanC = 0;
      for (let j = 0; j < block; j++) {
        for (let i = 0; i < block; i++) {
          const v = curr[(by + j) * nx + bx + i];
          meanC += v;
          if (v >= MOTION_ECHO) wet++;
        }
      }
      if (wet < n * 0.08) continue; // too little rain to follow
      meanC /= n;
      let varC = 0;
      for (let j = 0; j < block; j++) for (let i = 0; i < block; i++) varC += (curr[(by + j) * nx + bx + i] - meanC) ** 2;
      if (varC <= 1e-6) continue;

      let best = -1;
      let bestDx = 0;
      let bestDy = 0;
      for (let sy = -maxShift; sy <= maxShift; sy++) {
        for (let sx = -maxShift; sx <= maxShift; sx++) {
          // the block came from (bx - sx, by - sy) in the older picture
          const ox = bx - sx;
          const oy = by - sy;
          if (ox < 0 || oy < 0 || ox + block > nx || oy + block > ny) continue;
          let meanP = 0;
          for (let j = 0; j < block; j++) for (let i = 0; i < block; i++) meanP += prev[(oy + j) * nx + ox + i];
          meanP /= n;
          let cov = 0;
          let varP = 0;
          for (let j = 0; j < block; j++) {
            for (let i = 0; i < block; i++) {
              const p = prev[(oy + j) * nx + ox + i] - meanP;
              cov += p * (curr[(by + j) * nx + bx + i] - meanC);
              varP += p * p;
            }
          }
          if (varP <= 1e-6) continue;
          const r = cov / Math.sqrt(varP * varC);
          // prefer the smaller shift on near-ties, so still rain is not given a made-up motion
          if (r > best + 1e-6 || (Math.abs(r - best) <= 1e-6 && sx * sx + sy * sy < bestDx * bestDx + bestDy * bestDy)) {
            best = r;
            bestDx = sx;
            bestDy = sy;
          }
        }
      }
      if (best >= MIN_MATCH_QUALITY) {
        vectors.push({ x: bx + block / 2, y: by + block / 2, dx: bestDx, dy: bestDy, quality: best });
      }
    }
  }
  return vectors;
}

/** Motion at a point: quality- and distance-weighted mean of the vectors within `radius` cells, or null. */
export function motionAt(x: number, y: number, vectors: readonly MotionVector[], radius = 2 * MOTION_BLOCK): { dx: number; dy: number } | null {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (const v of vectors) {
    const d = Math.hypot(v.x - x, v.y - y);
    if (d > radius) continue;
    const w = v.quality / (1 + d / MOTION_BLOCK);
    sw += w;
    sx += w * v.dx;
    sy += w * v.dy;
  }
  return sw > 0 ? { dx: sx / sw, dy: sy / sw } : null;
}

/** Grid displacement over `minutes` to speed (km/h) and the compass direction the storm is moving towards. */
export function displacementToMotion(dx: number, dy: number, minutes: number, grid: TrackingGrid, lat: number): { speedKmh: number; towardsDeg: number } {
  const eastKm = dx * grid.step * KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const northKm = -dy * grid.step * KM_PER_DEG;
  const speedKmh = Math.hypot(eastKm, northKm) / (minutes / 60);
  const towardsDeg = (Math.atan2(eastKm, northKm) * 180 / Math.PI + 360) % 360;
  return { speedKmh, towardsDeg };
}

/** Wind (u east, v north, m/s) to storm motion: the storm moves with the steering wind, towards where it blows. */
export function windToMotion(u: number, v: number): { speedKmh: number; towardsDeg: number } {
  return { speedKmh: Math.hypot(u, v) * 3.6, towardsDeg: (Math.atan2(u, v) * 180 / Math.PI + 360) % 360 };
}

/** A point `km` away from (lat, lon) towards `deg` (flat-earth, fine for tens of km). */
export function offset(lat: number, lon: number, km: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [lon + (km * Math.sin(a)) / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180)), lat + (km * Math.cos(a)) / KM_PER_DEG];
}

/**
 * The cone a storm (centre lat/lon, radius km) sweeps over the next `minutes` moving at `speedKmh` towards `towardsDeg`:
 * a closed ring of [lon, lat] that starts at the storm's size and widens by CONE_SPREAD per km travelled.
 */
export function stormCone(lat: number, lon: number, radiusKm: number, speedKmh: number, towardsDeg: number, minutes = CONE_MINUTES): [number, number][] {
  const steps = 12;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  const length = (speedKmh * minutes) / 60;
  for (let s = 0; s <= steps; s++) {
    const d = (length * s) / steps;
    const [cx, cy] = offset(lat, lon, d, towardsDeg);
    const w = radiusKm + CONE_SPREAD * d;
    left.push(offset(cy, cx, w, towardsDeg - 90));
    right.push(offset(cy, cx, w, towardsDeg + 90));
  }
  const arc = (cLat: number, cLon: number, r: number, from: number, to: number): [number, number][] => {
    const pts: [number, number][] = [];
    for (let k = 1; k < 12; k++) pts.push(offset(cLat, cLon, r, from + ((to - from) * k) / 12));
    return pts;
  };
  const [ex, ey] = offset(lat, lon, length, towardsDeg);
  const wEnd = radiusKm + CONE_SPREAD * length;
  const ring = [
    ...left,
    ...arc(ey, ex, wEnd, towardsDeg - 90, towardsDeg + 90), // rounded front
    ...right.reverse(),
    ...arc(lat, lon, radiusKm, towardsDeg + 90, towardsDeg + 270), // rounded back around the storm itself
  ];
  ring.push(ring[0]);
  return ring;
}
