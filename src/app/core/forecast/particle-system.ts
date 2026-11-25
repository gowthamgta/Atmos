import { ForecastGrid, mercatorUnitX, mercatorUnitY } from './forecast.model';

export interface WindFieldData {
  grid: ForecastGrid;
  uA: Float32Array;
  vA: Float32Array;
  uB: Float32Array;
  vB: Float32Array;
  mix: number;
}

/** Two time steps of wind (m/s) on the forecast grid, plus optional 25 km global wind outside the regional box. */
export interface WindFrame extends WindFieldData {
  global?: WindFieldData;
}

/** The visible part of the map. */
export interface ViewState {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
}

/**
 * Screen speed of a particle: this many pixels per second for each m/s of wind, up to SPEED_KNEE_MS (see screenSpeed). 4.5 until 1 Nov 2026,
 * when the owner found the flow "dead slow"; 10 on 1 Nov, 7 since 2 Nov ("make the wind particles little slow").
 */
export const PX_PER_MS = 7;
/**
 * Up to this wind (m/s) a particle's screen speed grows in proportion; beyond it, with the square root of the excess ratio. A strong wind
 * still looks clearly faster, but a 30 m/s jet no longer races across the screen at five times the speed of a breeze, which looks
 * mechanical rather than like moving air (Windy and earth.nullschool compress the fast end too).
 */
export const SPEED_KNEE_MS = 6;
/** Zoomed out over all India (zoom 4 and less) the flow is drawn this much slower, rising to full speed at zoom 6. */
export const ZOOMED_OUT_SPEED = 0.9;
/** Floats per particle in the instance buffer: mercator x, y, screen velocity x, y (px/s), alpha, earlier screen velocity x, y (px/s). */
export const INSTANCE_FLOATS = 7;
/**
 * The earlier velocity a particle's tail bends towards: its velocity smoothed over this long (s), so the tail follows the path it has come
 * along through a turn instead of sticking out straight (the owner, 2 Nov 2026: "smooth edges while curving or turning").
 */
export const TRAIL_MEMORY_S = 0.2;

/**
 * How long a particle lives (s). Long enough that the eye follows each one along the flow: short lives (1.6-3.6 s before) made the whole
 * picture flicker, thousands of streaks appearing and vanishing at random, which was most restless zoomed out over all India.
 */
export const MIN_LIFE_S = 3.5;
export const MAX_LIFE_S = 7.5;
/** Fade in and out (s), so a particle eases into and out of view. */
const FADE_IN_S = 0.6;
const FADE_OUT_S = 1;
const SPAWN_MARGIN = 0.05; // fraction of the view added around it so particles are already moving at the edge

/** The screen speed (px/s) of a particle in a wind of `ms` m/s at a map zoom: in proportion up to SPEED_KNEE_MS, gentler beyond. */
export function screenSpeed(ms: number, zoom: number): number {
  const curved = ms <= SPEED_KNEE_MS ? ms : SPEED_KNEE_MS * Math.sqrt(ms / SPEED_KNEE_MS);
  const zoomFactor = ZOOMED_OUT_SPEED + (1 - ZOOMED_OUT_SPEED) * Math.min(1, Math.max(0, (zoom - 4) / 2));
  return curved * PX_PER_MS * zoomFactor;
}

/** Latitude tables of a grid (step LUT_STEP_DEG): mercator y and cos(lat), so a frame needs no log, tan or cos per particle. */
const LUT_STEP_DEG = 0.02;
interface LatTables {
  grid: ForecastGrid;
  lat0: number;
  mercY: Float64Array;
  cos: Float64Array;
}
function latTables(grid: ForecastGrid): LatTables {
  const latMin = grid.latMax - (grid.ny - 1) * grid.step - 1;
  const n = Math.ceil((grid.latMax + 1 - latMin) / LUT_STEP_DEG) + 2;
  const mercY = new Float64Array(n);
  const cos = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const lat = latMin + k * LUT_STEP_DEG;
    mercY[k] = mercatorUnitY(lat);
    cos[k] = Math.cos((lat * Math.PI) / 180);
  }
  return { grid, lat0: latMin, mercY, cos };
}

function sampleFieldUV(f: WindFieldData, lat: number, normLon: number): [number, number] {
  const g = f.grid;
  const isGlobal = g.step * g.nx >= 359;
  const gy = (g.latMax - lat) / g.step;
  if (gy < 0 || gy > g.ny - 1) return [NaN, NaN];
  let gx = (normLon - g.lonMin) / g.step;
  if (isGlobal) {
    gx = ((gx % g.nx) + g.nx) % g.nx;
  } else if (gx < 0 || gx > g.nx - 1) {
    return [NaN, NaN];
  }
  const y0 = Math.min(Math.max(Math.floor(gy), 0), g.ny - 2);
  const fy = Math.min(Math.max(gy - y0, 0), 1);
  const x0 = isGlobal ? Math.floor(gx) % g.nx : Math.min(Math.max(Math.floor(gx), 0), g.nx - 2);
  const x1 = isGlobal ? (x0 + 1) % g.nx : x0 + 1;
  const fx = isGlobal ? gx - Math.floor(gx) : Math.min(Math.max(gx - x0, 0), 1);
  const r0 = y0 * g.nx;
  const r1 = (y0 + 1) * g.nx;
  const i00 = r0 + x0;
  const i10 = r0 + x1;
  const i01 = r1 + x0;
  const i11 = r1 + x1;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const mixB = f.mix;
  const mixA = 1 - mixB;
  const u =
    mixA * (f.uA[i00] * w00 + f.uA[i10] * w10 + f.uA[i01] * w01 + f.uA[i11] * w11) +
    mixB * (f.uB[i00] * w00 + f.uB[i10] * w10 + f.uB[i01] * w01 + f.uB[i11] * w11);
  const v =
    mixA * (f.vA[i00] * w00 + f.vA[i10] * w10 + f.vA[i01] * w01 + f.vA[i11] * w11) +
    mixB * (f.vB[i00] * w00 + f.vB[i10] * w10 + f.vB[i01] * w01 + f.vB[i11] * w11);
  return [u, v];
}

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
  /** The velocity a little earlier (smoothed over TRAIL_MEMORY_S): where the tail bends to. */
  readonly pvx: Float32Array;
  readonly pvy: Float32Array;
  /** Wind speed (m/s) at the particle from the last step. */
  readonly speed: Float32Array;
  count: number;
  private tables: LatTables | null = null;

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
    this.pvx = new Float32Array(maxCount);
    this.pvy = new Float32Array(maxCount);
    this.speed = new Float32Array(maxCount);
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
    const activeGrid = wind.global?.grid ?? wind.grid;
    const region = spawnRegion(view, activeGrid);
    const pxPerDegLon = (512 * 2 ** view.zoom) / 360; // MapLibre world is 512 px wide at zoom 0
    if (this.tables?.grid !== activeGrid) this.tables = latTables(activeGrid);
    const { lat0, cos } = this.tables;
    const invStep = 1 / LUT_STEP_DEG;
    const lastLut = cos.length - 1.000001; // the tables reach a degree past the grid; a particle beyond reads their end
    // the speed curve is the same for every particle in a frame but for its wind: px/s per m/s up to the knee, then a square root
    const linear = screenSpeed(1, view.zoom);
    const kneeMs = SPEED_KNEE_MS;
    const kneeRoot = Math.sqrt(kneeMs);

    for (let i = 0; i < this.count; i++) {
      this.age[i] += dt;
      let lon = this.lon[i];
      let lat = this.lat[i];
      if (this.age[i] >= this.life[i] || lon < region.west || lon > region.east || lat < region.south || lat > region.north) {
        this.spawn(i, region);
        lon = this.lon[i];
        lat = this.lat[i];
      }

      const normLon = ((((lon + 180) % 360) + 360) % 360) - 180;
      let [u, v] = sampleFieldUV(wind, lat, normLon);
      if ((Number.isNaN(u) || Number.isNaN(v)) && wind.global) {
        [u, v] = sampleFieldUV(wind.global, lat, normLon);
      }

      if (Number.isNaN(u) || Number.isNaN(v)) {
        this.age[i] = this.life[i]; // no data here: respawn next step
        this.vx[i] = 0;
        this.vy[i] = 0;
        this.pvx[i] = 0;
        this.pvy[i] = 0;
        this.speed[i] = 0;
        continue;
      }
      const ms = Math.sqrt(u * u + v * v);
      // px/s per m/s for this wind (see screenSpeed): `linear` up to the knee, then falling off as 1/sqrt
      const k = ms <= kneeMs ? linear : (linear * kneeRoot) / Math.sqrt(ms);
      this.speed[i] = ms;
      this.vx[i] = u * k;
      this.vy[i] = -v * k;
      // the earlier velocity follows the current one with a short lag (a new particle starts straight)
      const follow = this.age[i] <= dt ? 1 : Math.min(1, dt / TRAIL_MEMORY_S);
      this.pvx[i] += (this.vx[i] - this.pvx[i]) * follow;
      this.pvy[i] += (this.vy[i] - this.pvy[i]) * follow;
      const t = Math.min(Math.max((lat - lat0) * invStep, 0), lastLut);
      const j = t | 0;
      const cosLat = cos[j] + (cos[j + 1] - cos[j]) * (t - j);
      this.lon[i] = lon + (this.vx[i] * dt) / pxPerDegLon;
      this.lat[i] = lat - (this.vy[i] * dt * cosLat) / pxPerDegLon;
    }
  }

  /** Fills `out` with INSTANCE_FLOATS per live particle and returns how many particles were written. */
  writeInstances(out: Float32Array, view?: ViewState): number {
    let n = 0;
    const tables = this.tables;
    const vEast = view ? (view.east > view.west ? view.east : view.east + 360) : 0;
    const centerLon = view ? view.west + (vEast - view.west) / 2 : 0;
    for (let i = 0; i < this.count; i++) {
      const speed = this.speed[i]; // m/s
      if (speed < 0.05) continue; // calm air: nothing to draw
      const fadeIn = Math.min(this.age[i] / FADE_IN_S, 1);
      const fadeOut = Math.min((this.life[i] - this.age[i]) / FADE_OUT_S, 1);
      const o = n * INSTANCE_FLOATS;
      let lon = this.lon[i];
      if (view) {
        let d = lon - centerLon;
        d = ((((d + 180) % 360) + 360) % 360) - 180;
        lon = centerLon + d;
      }
      out[o] = mercatorUnitX(lon);
      let y: number;
      if (tables) {
        const t = Math.min(Math.max((this.lat[i] - tables.lat0) / LUT_STEP_DEG, 0), tables.mercY.length - 1.000001);
        const j = t | 0;
        y = tables.mercY[j] + (tables.mercY[j + 1] - tables.mercY[j]) * (t - j);
      } else {
        y = mercatorUnitY(this.lat[i]);
      }
      out[o + 1] = y;
      out[o + 2] = this.vx[i];
      out[o + 3] = this.vy[i];
      out[o + 4] = Math.max(fadeIn * fadeOut, 0) * (0.3 + 0.7 * Math.min(speed / 12, 1));
      out[o + 5] = this.pvx[i];
      out[o + 6] = this.pvy[i];
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

/** The visible map (with a margin) clipped to the forecast domain (global grids keep unwrapped longitudes across dateline). */
export function spawnRegion(view: ViewState, grid: ForecastGrid): SpawnRegion {
  const isGlobal = grid.step * grid.nx >= 359;
  const latMin = grid.latMax - (grid.ny - 1) * grid.step;
  const vEast = view.east > view.west ? view.east : view.east + 360;
  const padX = (vEast - view.west) * SPAWN_MARGIN;
  const padY = (view.north - view.south) * SPAWN_MARGIN;
  const south = Math.max(view.south - padY, latMin);
  const north = Math.min(view.north + padY, grid.latMax);
  if (isGlobal) {
    const west = view.west - padX;
    const east = vEast + padX;
    if (south >= north) return { west, east, south: latMin, north: grid.latMax };
    return { west, east, south, north };
  }
  const lonMax = grid.lonMin + (grid.nx - 1) * grid.step;
  const west = Math.max(view.west - padX, grid.lonMin);
  const east = Math.min(vEast + padX, lonMax);
  if (west >= east || south >= north) return { west: grid.lonMin, east: lonMax, south: latMin, north: grid.latMax };
  return { west, east, south, north };
}

/**
 * How many wind streaks to draw, kept to what the device can animate. When frames stay slow (an average over 28 ms, under 36 frames a
 * second) for a second, 15% of the streaks go, down to a floor. When they stay fast (under 18.5 ms, near 60 frames a second) for six seconds,
 * 8% come back, but never up to the count that was too many before: so a slow moment (a window being resized, the first pictures decoding)
 * does not leave the animation thin for the rest of the visit, and a device that can only just keep up does not swing between two counts.
 */
export class AdaptiveCount {
  static readonly SLOW_MS = 28;
  static readonly FAST_MS = 18.5;
  static readonly SLOW_FOR_MS = 1000;
  static readonly FAST_FOR_MS = 6000;

  private ema = 16.7;
  private slowSince = 0;
  private fastSince = 0;
  private ceiling = Infinity;

  constructor(readonly min: number, readonly max: number) {}

  /** The smoothed time between frames (ms). */
  get frameMs(): number {
    return this.ema;
  }

  /** Forget what was learnt (the view changed a lot): the full count may be tried again. */
  reset(): void {
    this.ceiling = Infinity;
    this.slowSince = 0;
    this.fastSince = 0;
  }

  /** Feed one frame (`dtMs` since the last, at time `nowMs`) and the count now in use. Returns the new count, or null to keep it. */
  update(nowMs: number, dtMs: number, count: number): number | null {
    if (dtMs <= 0) return null;
    this.ema = this.ema * 0.9 + dtMs * 0.1;
    if (this.ema > AdaptiveCount.SLOW_MS) {
      this.fastSince = 0;
      this.slowSince ||= nowMs;
      if (nowMs - this.slowSince > AdaptiveCount.SLOW_FOR_MS && count > this.min) {
        this.slowSince = nowMs;
        this.ceiling = Math.min(this.ceiling, count * 0.97);
        return Math.max(this.min, Math.round(count * 0.85));
      }
    } else if (this.ema < AdaptiveCount.FAST_MS) {
      this.slowSince = 0;
      this.fastSince ||= nowMs;
      const limit = Math.min(this.max, this.ceiling);
      if (nowMs - this.fastSince > AdaptiveCount.FAST_FOR_MS && count < limit) {
        this.fastSince = nowMs;
        return Math.min(limit, Math.round(count * 1.08));
      }
    } else {
      this.slowSince = 0;
      this.fastSince = 0;
    }
    return null;
  }
}
