import { ForecastGrid, mercatorUnitX, mercatorUnitY } from './forecast.model';

/** Two time steps of the 10 m wind (m/s) on the forecast grid, blended by `mix`. */
export interface WindFrame {
  grid: ForecastGrid;
  uA: Float32Array;
  vA: Float32Array;
  uB: Float32Array;
  vB: Float32Array;
  mix: number;
}

/** The visible part of the map. */
export interface ViewState {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
}

/** Screen speed of a particle: this many pixels per second for each m/s of wind. */
export const PX_PER_MS = 4.5;
/** Floats per particle in the instance buffer: mercator x, y, screen velocity x, y (px/s), alpha. */
export const INSTANCE_FLOATS = 5;

const MIN_LIFE_S = 1.6;
const MAX_LIFE_S = 3.6;
const SPAWN_MARGIN = 0.05; // fraction of the view added around it so particles are already moving at the edge

/**
 * Wind particles advected in map space, so panning and zooming never invalidates them. Screen speed is kept
 * constant at every zoom level (a faster wind always looks faster, and zooming in does not slow the flow).
 */
export class ParticleSystem {
  readonly lon: Float32Array;
  readonly lat: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  /** Screen velocity in px/s (x to the right, y down) from the last step. */
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  count: number;

  constructor(
    readonly maxCount: number,
    count = maxCount,
    private readonly random: () => number = Math.random
  ) {
    this.lon = new Float32Array(maxCount);
    this.lat = new Float32Array(maxCount);
    this.age = new Float32Array(maxCount);
    this.life = new Float32Array(maxCount);
    this.vx = new Float32Array(maxCount);
    this.vy = new Float32Array(maxCount);
    this.count = Math.min(count, maxCount);
  }

  setCount(n: number): void {
    this.count = Math.max(0, Math.min(Math.floor(n), this.maxCount));
  }

  /** Scatter every particle at a random age inside the spawn region (avoids a synchronised first wave). */
  reset(view: ViewState, grid: ForecastGrid): void {
    const region = spawnRegion(view, grid);
    for (let i = 0; i < this.maxCount; i++) {
      this.spawn(i, region);
      this.age[i] = this.random() * this.life[i];
    }
  }

  step(dt: number, wind: WindFrame, view: ViewState): void {
    const g = wind.grid;
    const region = spawnRegion(view, g);
    const pxPerDegLon = (512 * 2 ** view.zoom) / 360; // MapLibre world is 512 px wide at zoom 0
    const mixB = wind.mix;
    const mixA = 1 - mixB;
    const { uA, vA, uB, vB } = wind;

    for (let i = 0; i < this.count; i++) {
      this.age[i] += dt;
      let lon = this.lon[i];
      let lat = this.lat[i];
      if (this.age[i] >= this.life[i] || lon < region.west || lon > region.east || lat < region.south || lat > region.north) {
        this.spawn(i, region);
        lon = this.lon[i];
        lat = this.lat[i];
      }

      // bilinear wind at the particle, both time steps with one set of weights
      const gx = (lon - g.lonMin) / g.step;
      const gy = (g.latMax - lat) / g.step;
      const x0 = Math.min(Math.max(Math.floor(gx), 0), g.nx - 2);
      const y0 = Math.min(Math.max(Math.floor(gy), 0), g.ny - 2);
      const fx = Math.min(Math.max(gx - x0, 0), 1);
      const fy = Math.min(Math.max(gy - y0, 0), 1);
      const i00 = y0 * g.nx + x0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const u = mixA * (uA[i00] * w00 + uA[i00 + 1] * w10 + uA[i00 + g.nx] * w01 + uA[i00 + g.nx + 1] * w11) +
        mixB * (uB[i00] * w00 + uB[i00 + 1] * w10 + uB[i00 + g.nx] * w01 + uB[i00 + g.nx + 1] * w11);
      const v = mixA * (vA[i00] * w00 + vA[i00 + 1] * w10 + vA[i00 + g.nx] * w01 + vA[i00 + g.nx + 1] * w11) +
        mixB * (vB[i00] * w00 + vB[i00 + 1] * w10 + vB[i00 + g.nx] * w01 + vB[i00 + g.nx + 1] * w11);

      if (Number.isNaN(u) || Number.isNaN(v)) {
        this.age[i] = this.life[i]; // no data here: respawn next step
        this.vx[i] = 0;
        this.vy[i] = 0;
        continue;
      }
      this.vx[i] = u * PX_PER_MS;
      this.vy[i] = -v * PX_PER_MS;
      this.lon[i] = lon + (this.vx[i] * dt) / pxPerDegLon;
      this.lat[i] = lat - (this.vy[i] * dt * Math.cos((lat * Math.PI) / 180)) / pxPerDegLon;
    }
  }

  /** Fills `out` with INSTANCE_FLOATS per live particle and returns how many particles were written. */
  writeInstances(out: Float32Array): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const speed = Math.hypot(this.vx[i], this.vy[i]) / PX_PER_MS; // m/s
      if (speed < 0.05) continue; // calm air: nothing to draw
      const fadeIn = Math.min(this.age[i] / 0.3, 1);
      const fadeOut = Math.min((this.life[i] - this.age[i]) / 0.5, 1);
      const o = n * INSTANCE_FLOATS;
      out[o] = mercatorUnitX(this.lon[i]);
      out[o + 1] = mercatorUnitY(this.lat[i]);
      out[o + 2] = this.vx[i];
      out[o + 3] = this.vy[i];
      out[o + 4] = Math.max(fadeIn * fadeOut, 0) * (0.3 + 0.7 * Math.min(speed / 12, 1));
      n++;
    }
    return n;
  }

  private spawn(i: number, r: SpawnRegion): void {
    this.lon[i] = r.west + this.random() * (r.east - r.west);
    this.lat[i] = r.south + this.random() * (r.north - r.south);
    this.age[i] = 0;
    this.life[i] = MIN_LIFE_S + this.random() * (MAX_LIFE_S - MIN_LIFE_S);
  }
}

interface SpawnRegion {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** The visible map (with a margin) clipped to the forecast domain; the whole domain if they do not overlap. */
export function spawnRegion(view: ViewState, grid: ForecastGrid): SpawnRegion {
  const lonMax = grid.lonMin + (grid.nx - 1) * grid.step;
  const latMin = grid.latMax - (grid.ny - 1) * grid.step;
  const padX = (view.east - view.west) * SPAWN_MARGIN;
  const padY = (view.north - view.south) * SPAWN_MARGIN;
  const west = Math.max(view.west - padX, grid.lonMin);
  const east = Math.min(view.east + padX, lonMax);
  const south = Math.max(view.south - padY, latMin);
  const north = Math.min(view.north + padY, grid.latMax);
  if (west >= east || south >= north) return { west: grid.lonMin, east: lonMax, south: latMin, north: grid.latMax };
  return { west, east, south, north };
}
