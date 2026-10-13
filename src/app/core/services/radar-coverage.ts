import { mercatorUnitX, mercatorUnitY } from '../forecast/forecast.model';

/**
 * Where the IMD radars can see rain near the ground, as baked from the terrain by pipeline/build_radar_coverage.py (public/data/radar-coverage.*).
 *
 * A radar beam climbs away from the ground as it travels and mountains can block part of it, so far from a radar, or behind hills, low rain
 * goes unseen and an empty picture does not mean a dry day. The map says so with a faint haze under the echoes.
 */
export const COVERAGE_NONE = 0;
export const COVERAGE_POOR = 1;
export const COVERAGE_LIMITED = 2;
export const COVERAGE_GOOD = 3;

export interface CoverageMeta {
  version: number;
  south: number;
  north: number;
  west: number;
  east: number;
  /** Degrees between cells: the cell at row j, column i is centred on latitude north - j * step and longitude west + i * step. */
  step: number;
  nx: number;
  ny: number;
  assumptions: { lowestSweepDeg: number; beamWidthDeg: Record<string, number>; antennaM: number };
  stations: { id: string; lat: number; lng: number; band: string; rangeKm: number }[];
}

export interface CoverageGrid {
  meta: CoverageMeta;
  /** One class per cell, row 0 at the north edge. */
  classes: Uint8Array;
}

/** The class at a place: the nearest cell, and none outside the box. */
export function coverageAt(grid: CoverageGrid, lat: number, lon: number): number {
  const m = grid.meta;
  const x = Math.round((lon - m.west) / m.step);
  const y = Math.round((m.north - lat) / m.step);
  if (x < 0 || y < 0 || x >= m.nx || y >= m.ny) return COVERAGE_NONE;
  return grid.classes[y * m.nx + x];
}

/** What each class is called, from the best to the worst. */
export const COVERAGE_LEGEND: readonly { cls: number; label: string; hint: string }[] = [
  { cls: COVERAGE_GOOD, label: 'Seen well', hint: 'Close to a radar: the beam is low over the ground' },
  { cls: COVERAGE_LIMITED, label: 'Partly seen', hint: 'Farther away or behind hills: the beam passes above the lowest rain' },
  { cls: COVERAGE_POOR, label: 'Mostly missed', hint: 'The beam is far above the ground or blocked by mountains: only tall storms show' },
  { cls: COVERAGE_NONE, label: 'No radar', hint: 'Out of range of every radar: a blank here says nothing about rain' },
];

/** Opacity of the haze over each class (the best is clear, so the haze only marks where the radar is weaker). */
const HAZE_ALPHA: Record<number, number> = {
  [COVERAGE_NONE]: 0.3,
  [COVERAGE_POOR]: 0.18,
  [COVERAGE_LIMITED]: 0.07,
  [COVERAGE_GOOD]: 0,
};

/** The haze opacity of a class, 0 to 1 (for the legend's swatches). */
export function hazeAlpha(cls: number): number {
  return HAZE_ALPHA[cls] ?? 0;
}
/** Slate, light enough to show on the dark map and over the sea. */
export const HAZE_RGB: readonly [number, number, number] = [104, 120, 146];

/** Corners [lng, lat] (NW, NE, SE, SW) of the picture: the cells are centred on the grid, so it reaches half a step past it. */
export function coverageCorners(meta: CoverageMeta): [[number, number], [number, number], [number, number], [number, number]] {
  const h = meta.step / 2;
  const n = meta.north + h;
  const s = meta.south - h;
  const w = meta.west - h;
  const e = meta.east + h;
  return [[w, n], [e, n], [e, s], [w, s]];
}

function latitudeFromMercatorUnit(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/**
 * The haze as an RGBA picture, `width` pixels wide, with its rows evenly spaced in Mercator (the map's own projection), so it lies on the
 * ground where the grid says. The opacity is interpolated between the cells, so the edges between classes are soft.
 */
export function coverageHaze(grid: CoverageGrid, width: number): { width: number; height: number; pixels: Uint8ClampedArray } {
  const m = grid.meta;
  const [[west, north], [east, south]] = [coverageCorners(m)[0], coverageCorners(m)[2]];
  const x0 = mercatorUnitX(west);
  const x1 = mercatorUnitX(east);
  const y0 = mercatorUnitY(north);
  const y1 = mercatorUnitY(south);
  const height = Math.max(1, Math.round((width * (y1 - y0)) / (x1 - x0)));
  const pixels = new Uint8ClampedArray(width * height * 4);
  const alphaAt = (i: number, j: number): number => {
    const x = Math.min(Math.max(i, 0), m.nx - 1);
    const y = Math.min(Math.max(j, 0), m.ny - 1);
    return HAZE_ALPHA[grid.classes[y * m.nx + x]] ?? 0;
  };
  for (let r = 0; r < height; r++) {
    const lat = latitudeFromMercatorUnit(y0 + ((r + 0.5) / height) * (y1 - y0));
    const fy = (m.north - lat) / m.step;
    const j = Math.floor(fy);
    const ty = fy - j;
    for (let c = 0; c < width; c++) {
      const lon = west + ((c + 0.5) / width) * (east - west);
      const fx = (lon - m.west) / m.step;
      const i = Math.floor(fx);
      const tx = fx - i;
      const a =
        (alphaAt(i, j) * (1 - tx) + alphaAt(i + 1, j) * tx) * (1 - ty) +
        (alphaAt(i, j + 1) * (1 - tx) + alphaAt(i + 1, j + 1) * tx) * ty;
      const o = (r * width + c) * 4;
      pixels[o] = HAZE_RGB[0];
      pixels[o + 1] = HAZE_RGB[1];
      pixels[o + 2] = HAZE_RGB[2];
      pixels[o + 3] = Math.round(a * 255);
    }
  }
  return { width, height, pixels };
}

export function parseCoverageMeta(json: unknown): CoverageMeta | null {
  const m = json as Partial<CoverageMeta> | null;
  if (!m || typeof m.step !== 'number' || typeof m.nx !== 'number' || typeof m.ny !== 'number' || typeof m.north !== 'number' || typeof m.west !== 'number') return null;
  return m as CoverageMeta;
}
