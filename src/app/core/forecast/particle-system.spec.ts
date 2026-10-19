import { describe, expect, it } from 'vitest';
import { bestMs } from '../testing/bench';
import { ForecastGrid, mercatorUnitY } from './forecast.model';
import {
  AdaptiveCount, INSTANCE_FLOATS, MAX_LIFE_S, MIN_LIFE_S, PX_PER_MS, ParticleSystem, SPEED_KNEE_MS, ViewState, WindFrame, screenSpeed, spawnRegion,
} from './particle-system';

const GRID: ForecastGrid = { latMax: 22, latMin: 4, lonMin: 68, lonMax: 90, step: 0.1, nx: 221, ny: 181 };
const VIEW: ViewState = { west: 74, south: 8, east: 80, north: 14, zoom: 6 };

/** Seeded generator so the tests are deterministic. */
function rng(seed = 42): () => number {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

function uniformWind(u: number, v: number, mix = 0): WindFrame {
  const n = GRID.nx * GRID.ny;
  return {
    grid: GRID,
    uA: new Float32Array(n).fill(u),
    vA: new Float32Array(n).fill(v),
    uB: new Float32Array(n).fill(u),
    vB: new Float32Array(n).fill(v),
    mix,
  };
}

describe('spawnRegion', () => {
  it('is the view plus a margin, clipped to the forecast domain', () => {
    const r = spawnRegion(VIEW, GRID);
    expect(r.west).toBeLessThan(VIEW.west);
    expect(r.east).toBeGreaterThan(VIEW.east);
    const wide = spawnRegion({ west: 40, south: -20, east: 120, north: 50, zoom: 3 }, GRID);
    expect(wide).toEqual({ west: 68, east: 90, south: 4, north: 22 });
  });

  it('falls back to the whole domain when the view is elsewhere', () => {
    expect(spawnRegion({ west: 100, south: 40, east: 110, north: 45, zoom: 5 }, GRID)).toEqual({ west: 68, east: 90, south: 4, north: 22 });
  });
});

describe('ParticleSystem', () => {
  it('keeps every particle inside the visible area after resetting', () => {
    const ps = new ParticleSystem(500, 500, rng());
    ps.reset(VIEW, GRID);
    const r = spawnRegion(VIEW, GRID);
    for (let i = 0; i < 500; i++) {
      expect(ps.lon[i]).toBeGreaterThanOrEqual(r.west);
      expect(ps.lon[i]).toBeLessThanOrEqual(r.east);
      expect(ps.lat[i]).toBeGreaterThanOrEqual(r.south);
      expect(ps.lat[i]).toBeLessThanOrEqual(r.north);
    }
  });

  it('moves with the wind at a constant screen speed (a westerly blows particles east)', () => {
    const ps = new ParticleSystem(50, 50, rng());
    ps.reset(VIEW, GRID);
    ps.age.fill(0);
    ps.life.fill(100); // no respawns during this test
    const lon0 = Float32Array.from(ps.lon);
    const lat0 = Float32Array.from(ps.lat);
    ps.step(0.5, uniformWind(10, 0), { west: 0, south: 0, east: 180, north: 90, zoom: 6 });
    const pxPerDegLon = (512 * 2 ** 6) / 360;
    for (let i = 0; i < 50; i++) {
      expect((ps.lon[i] - lon0[i]) * pxPerDegLon).toBeCloseTo(screenSpeed(10, 6) * 0.5, 1); // pixels travelled
      expect(ps.lat[i]).toBeCloseTo(lat0[i], 4);
      expect(ps.vx[i]).toBeCloseTo(screenSpeed(10, 6), 3);
      expect(ps.vy[i]).toBeCloseTo(0, 6);
    }
  });

  it('moves north for a southerly wind (v > 0) and flips the screen y velocity', () => {
    const ps = new ParticleSystem(20, 20, rng());
    ps.reset(VIEW, GRID);
    ps.life.fill(100);
    ps.age.fill(0);
    const lat0 = Float32Array.from(ps.lat);
    ps.step(0.5, uniformWind(0, 8), { west: 0, south: 0, east: 180, north: 90, zoom: 6 });
    for (let i = 0; i < 20; i++) {
      expect(ps.lat[i]).toBeGreaterThan(lat0[i]);
      expect(ps.vy[i]).toBeLessThan(0); // screen y points down, so north is negative
    }
  });

  it('moves the same number of screen pixels east or north in the same wind (Mercator, 11.7 N)', () => {
    const zoom = 8;
    const world = 512 * 2 ** zoom; // MapLibre's world size in CSS pixels
    const px = (lon: number, lat: number) => ({
      x: ((lon + 180) / 360) * world,
      y: (world / (2 * Math.PI)) * (Math.PI - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))),
    });
    const view: ViewState = { west: 74, south: 8, east: 80, north: 14, zoom };
    const east = new ParticleSystem(1, 1, rng());
    const north = new ParticleSystem(1, 1, rng());
    for (const ps of [east, north]) {
      ps.reset(view, GRID);
      ps.life.fill(100);
      ps.age.fill(0);
      ps.lon[0] = 78;
      ps.lat[0] = 11.7;
    }
    const start = px(78, 11.7);
    east.step(0.5, uniformWind(8, 0), { west: 0, south: 0, east: 180, north: 90, zoom });
    north.step(0.5, uniformWind(0, 8), { west: 0, south: 0, east: 180, north: 90, zoom });
    const e = px(east.lon[0], east.lat[0]);
    const n = px(north.lon[0], north.lat[0]);
    const expected = screenSpeed(8, zoom) * 0.5; // 8 m/s for half a second, in screen pixels
    expect(Math.hypot(e.x - start.x, e.y - start.y)).toBeCloseTo(expected, 1);
    expect(Math.hypot(n.x - start.x, n.y - start.y)).toBeCloseTo(expected, 1);
  });

  it('blends the two time steps', () => {
    const ps = new ParticleSystem(5, 5, rng());
    ps.reset(VIEW, GRID);
    ps.life.fill(100);
    const wind = uniformWind(0, 0, 0.25);
    wind.uB.fill(8);
    ps.step(0.1, wind, VIEW);
    for (let i = 0; i < 5; i++) expect(ps.vx[i]).toBeCloseTo(0.25 * 8 * PX_PER_MS, 3);
  });

  it('respawns expired particles and particles that leave the view', () => {
    const ps = new ParticleSystem(100, 100, rng());
    ps.reset(VIEW, GRID);
    ps.age.fill(1000); // everything expired
    ps.step(0.016, uniformWind(3, 3), VIEW);
    const r = spawnRegion(VIEW, GRID);
    for (let i = 0; i < 100; i++) {
      expect(ps.age[i]).toBeLessThan(0.1);
      expect(ps.lon[i]).toBeGreaterThanOrEqual(r.west - 0.01);
      expect(ps.lon[i]).toBeLessThanOrEqual(r.east + 0.01);
    }
    ps.lon.fill(100); // far outside the domain
    ps.step(0.016, uniformWind(0, 0), VIEW);
    for (let i = 0; i < 100; i++) expect(ps.lon[i]).toBeLessThanOrEqual(r.east + 0.01);
  });

  it('respawns particles over no-data cells instead of drawing them', () => {
    const ps = new ParticleSystem(30, 30, rng());
    ps.reset(VIEW, GRID);
    const wind = uniformWind(NaN, NaN);
    ps.step(0.016, wind, VIEW);
    expect(ps.vx.every(v => v === 0)).toBe(true);
    const out = new Float32Array(30 * INSTANCE_FLOATS);
    expect(ps.writeInstances(out)).toBe(0);
  });

  it('writes mercator positions, screen velocity and fading alpha', () => {
    const ps = new ParticleSystem(10, 10, rng());
    ps.reset(VIEW, GRID);
    ps.age.fill(0.3);
    ps.life.fill(10);
    ps.step(0.0, uniformWind(6, 0), VIEW);
    const out = new Float32Array(10 * INSTANCE_FLOATS);
    const n = ps.writeInstances(out);
    expect(n).toBe(10);
    const x = out[0];
    const y = out[1];
    expect(x).toBeGreaterThan((74 + 180) / 360 - 0.01);
    expect(y).toBeGreaterThan(0.4);
    expect(out[2]).toBeCloseTo(6 * PX_PER_MS, 3);
    expect(out[4]).toBeGreaterThan(0.3);
    expect(out[4]).toBeLessThanOrEqual(1);
  });

  it('draws fewer particles when the budget is reduced', () => {
    const ps = new ParticleSystem(1000, 1000, rng());
    ps.reset(VIEW, GRID);
    ps.life.fill(100);
    ps.age.fill(1);
    ps.setCount(250);
    ps.step(0.016, uniformWind(5, 0), VIEW);
    expect(ps.writeInstances(new Float32Array(1000 * INSTANCE_FLOATS))).toBe(250);
    ps.setCount(5000);
    expect(ps.count).toBe(1000);
  });

  it('simulates and packs 9000 particles well inside a frame (CPU budget)', () => {
    const ps = new ParticleSystem(9000, 9000, rng());
    ps.reset(VIEW, GRID);
    const wind = uniformWind(5, 3, 0.5);
    const out = new Float32Array(9000 * INSTANCE_FLOATS);
    for (let i = 0; i < 20; i++) ps.step(0.016, wind, VIEW); // warm up
    const msPerFrame = bestMs(5, 20, () => {
      ps.step(0.016, wind, VIEW);
      ps.writeInstances(out);
    });
    console.info(`particle step + pack, 9000 particles: ${msPerFrame.toFixed(2)} ms/frame (best of 5 batches)`);
    expect(msPerFrame).toBeLessThan(6); // a 60 fps frame is 16.7 ms; leave most of it for drawing
  });
});

describe('how the wind looks', () => {
  it('moves in proportion to the wind up to the knee, and gentler beyond, so a strong wind is faster but does not race', () => {
    expect(screenSpeed(3, 6)).toBeCloseTo(3 * PX_PER_MS, 6);
    expect(screenSpeed(SPEED_KNEE_MS, 6)).toBeCloseTo(SPEED_KNEE_MS * PX_PER_MS, 6);
    const ratio = screenSpeed(30, 6) / screenSpeed(6, 6);
    expect(ratio).toBeGreaterThan(1.8); // still clearly faster
    expect(ratio).toBeLessThan(2.6);    // not five times as fast
    for (let ms = 0.5; ms < 40; ms += 0.5) expect(screenSpeed(ms + 0.5, 6)).toBeGreaterThan(screenSpeed(ms, 6)); // always faster with more wind
  });

  it('draws the flow a little slower zoomed out over all India, full speed from zoom 6', () => {
    expect(screenSpeed(10, 4)).toBeCloseTo(0.8 * screenSpeed(10, 6), 6);
    expect(screenSpeed(10, 3)).toBeCloseTo(screenSpeed(10, 4), 6);
    expect(screenSpeed(10, 9)).toBeCloseTo(screenSpeed(10, 6), 6);
  });

  it('a strong wind moves particles by the curve, not in proportion', () => {
    const ps = new ParticleSystem(10, 10, rng());
    ps.reset(VIEW, GRID);
    ps.life.fill(100);
    ps.step(0.1, uniformWind(24, 0), VIEW);
    for (let i = 0; i < 10; i++) {
      expect(ps.vx[i]).toBeCloseTo(screenSpeed(24, VIEW.zoom), 2);
      expect(ps.speed[i]).toBeCloseTo(24, 4);
    }
  });

  it('lets particles live long enough to be followed (no flicker of short-lived streaks)', () => {
    const ps = new ParticleSystem(500, 500, rng());
    ps.reset(VIEW, GRID);
    for (let i = 0; i < 500; i++) {
      expect(ps.life[i]).toBeGreaterThanOrEqual(MIN_LIFE_S);
      expect(ps.life[i]).toBeLessThanOrEqual(MAX_LIFE_S);
    }
    expect(MIN_LIFE_S).toBeGreaterThanOrEqual(3);
  });

  it('places particles on the map exactly, from its latitude tables (no log or tan per particle)', () => {
    const grid: ForecastGrid = { latMax: 37.5, latMin: 5, lonMin: 68, lonMax: 97.5, step: 0.25, nx: 119, ny: 131 };
    const ps = new ParticleSystem(200, 200, rng(7));
    const view: ViewState = { west: 66, south: 4, east: 100, north: 38, zoom: 4 };
    ps.reset(view, grid);
    ps.age.fill(1);
    ps.life.fill(100);
    const n = grid.nx * grid.ny;
    ps.step(0.016, { grid, uA: new Float32Array(n).fill(3), vA: new Float32Array(n).fill(2), uB: new Float32Array(n).fill(3), vB: new Float32Array(n).fill(2), mix: 0 }, view);
    const out = new Float32Array(200 * INSTANCE_FLOATS);
    const written = ps.writeInstances(out);
    expect(written).toBe(200);
    for (let i = 0; i < written; i++) expect(out[i * INSTANCE_FLOATS + 1]).toBeCloseTo(mercatorUnitY(ps.lat[i]), 7);
  });
});

describe('AdaptiveCount (how many streaks the device can animate)', () => {
  /** Runs frames of `frameMs` for `seconds`, applying each change, and returns the final count. */
  function run(a: AdaptiveCount, start: { count: number; t: number }, frameMs: number, seconds: number): { count: number; t: number } {
    let { count, t } = start;
    const end = t + seconds * 1000;
    while (t < end) {
      t += frameMs;
      const next = a.update(t, frameMs, count);
      if (next !== null) count = next;
    }
    return { count, t };
  }

  it('leaves the count alone while frames come at about 60 per second', () => {
    const a = new AdaptiveCount(2500, 11000);
    expect(run(a, { count: 11000, t: 0 }, 16.7, 10).count).toBe(11000);
  });

  it('takes 15% off each second that frames stay slow, down to the floor', () => {
    const a = new AdaptiveCount(2500, 11000);
    const after2 = run(a, { count: 11000, t: 0 }, 40, 3);                // 25 frames a second
    expect(after2.count).toBeLessThan(11000 * 0.85);
    expect(after2.count).toBeGreaterThan(11000 * 0.5);
    expect(run(a, after2, 40, 60).count).toBe(2500);                      // never below the floor
  });

  it('brings streaks back after the slow time is over, in small steps and after a steady six seconds', () => {
    const a = new AdaptiveCount(2500, 11000);
    const slow = run(a, { count: 11000, t: 0 }, 40, 2);
    const fast = run(a, slow, 16.7, 4);
    expect(fast.count).toBe(slow.count);                                  // the average has to fall under the line first, and then hold six seconds
    const later = run(a, fast, 16.7, 12);
    expect(later.count).toBeGreaterThan(slow.count);
    expect(later.count).toBeLessThan(slow.count * 1.08 * 3);
  });

  it('never goes back up to the count that was too many (a device that only just keeps up does not swing)', () => {
    const a = new AdaptiveCount(2500, 11000);
    const slow = run(a, { count: 11000, t: 0 }, 40, 1.2);                // one cut, from 11000
    const tooMany = 11000;
    const long = run(a, slow, 16.7, 120);
    expect(long.count).toBeLessThan(tooMany);
    expect(long.count).toBeLessThanOrEqual(Math.round(tooMany * 0.97));
  });

  it('can be told to forget (the view changed a lot)', () => {
    const a = new AdaptiveCount(2500, 11000);
    const slow = run(a, { count: 11000, t: 0 }, 40, 1.2);
    a.reset();
    const long = run(a, slow, 16.7, 120);
    expect(long.count).toBe(11000);
  });

  it('ignores a frame with no time between it and the last', () => {
    const a = new AdaptiveCount(500, 1000);
    expect(a.update(100, 0, 1000)).toBeNull();
  });
});
