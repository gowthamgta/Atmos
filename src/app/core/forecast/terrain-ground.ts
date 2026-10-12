import type { ForecastGrid } from './forecast.model';

/** The ground at a point: height in metres and the share of it that is land (0 to 1). */
export interface Ground {
  z: number;
  land: number;
}

const EPS = 1e-6;

/**
 * Whether two grids are the same lattice: the same spacing, and nodes that fall on each other (the offset between them is a whole number of
 * cells). The model-ground picture of the terrain is on the 0.1 degree India lattice, as ECMWF IFS and the UK Met Office are; GFS, AIGFS and AIFS
 * are published on 0.25 degrees, which is not.
 */
export function sameLattice(a: ForecastGrid, b: ForecastGrid): boolean {
  if (Math.abs(a.step - b.step) > EPS) return false;
  const across = (a.lonMin - b.lonMin) / a.step;
  const down = (a.latMax - b.latMax) / a.step;
  return Math.abs(across - Math.round(across)) < 1e-3 && Math.abs(down - Math.round(down)) < 1e-3;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * The ground a forecast picture stands on at a point, when the picture's grid is not the lattice the model-ground picture is on.
 *
 * A picture is the model's values at the nodes of its own grid, and between nodes it is interpolated (bilinearly, by the shader and by the click
 * card). The ground it effectively has there is therefore the model ground at those same nodes, interpolated the same way. Reading the
 * model-ground picture straight at the point would instead give the ground's own variation between the nodes, which the picture does not have,
 * and the terrain correction would then correct for hills the model was never sampled on. On a shared lattice the two are the same thing, so
 * the caller reads the picture directly (see sameLattice).
 *
 * `ground(lat, lon)` reads the model-ground picture at a place. The grid position is clamped the way the field's own sampling clamps it.
 */
export function groundAtFieldNodes(ground: (lat: number, lon: number) => Ground, field: ForecastGrid, lat: number, lon: number): Ground {
  const gx = clamp((lon - field.lonMin) / field.step, 0, field.nx - 1.0001);
  const gy = clamp((field.latMax - lat) / field.step, 0, field.ny - 1.0001);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  let z = 0;
  let land = 0;
  for (let k = 0; k < 4; k++) {
    const ox = k & 1;
    const oy = k >> 1;
    const ix = Math.min(x0 + ox, field.nx - 1);
    const iy = Math.min(y0 + oy, field.ny - 1);
    const w = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
    const g = ground(field.latMax - iy * field.step, field.lonMin + ix * field.step);
    z += g.z * w;
    land += g.land * w;
  }
  return { z, land };
}
