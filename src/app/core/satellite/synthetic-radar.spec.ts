import { CoreFeatures, SYNTHETIC_RADAR_CONFIG, SyntheticRadarOutput, WindGrids, classifyPixel, coreStrength, synthesizeRadar, tuneConfig } from './synthetic-radar';

const features = (p: Partial<CoreFeatures>): CoreFeatures => ({ tK: 230, ringDiffK: 0, sigmaK: 0, coolingK: NaN, tailK: 0, leadK: 0, ...p });

// a grid about 3 km a pixel over South India (the data pack's spacing); the rain grid is twice as fine
const box = { west: 76, east: 79, south: 9, north: 12 };
const W = 110, H = 110;
const grid = (fill: (x: number, y: number) => number): Float32Array => {
  const a = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = fill(x, y);
  return a;
};
/** The strongest reflectivity over data pixels x0..x1, y0..y1. */
const maxIn = (out: SyntheticRadarOutput, x0: number, y0: number, x1: number, y1: number): number => {
  const s = out.w / W;
  let m = 0;
  for (let y = y0 * s; y < (y1 + 1) * s; y++) for (let x = x0 * s; x < (x1 + 1) * s; x++) m = Math.max(m, out.dbz4[y * out.w + x] / 4);
  return m;
};
/** How many data pixels' worth of rain (any reflectivity) there is over the box. */
const rainArea = (out: SyntheticRadarOutput): number => out.dbz4.reduce((a, v) => a + (v > 0 ? 1 : 0), 0) / (out.w / W) ** 2;
const mercY = (lat: number) => 0.5 - Math.log((1 + Math.sin((lat * Math.PI) / 180)) / (1 - Math.sin((lat * Math.PI) / 180))) / (4 * Math.PI);
const latOf = (y: number) => {
  const m = mercY(12) + ((y + 0.5) / H) * (mercY(9) - mercY(12));
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * m))) * 180) / Math.PI;
};
const lonOf = (x: number) => box.west + ((x + 0.5) / W) * (box.east - box.west);
const steady = (u: number, v: number): WindGrids => {
  const n = 20 * 20;
  return { grid: { latMax: 12.5, lonMin: 75.5, step: 0.25, nx: 20, ny: 20 }, u850: new Float32Array(n).fill(u), v850: new Float32Array(n).fill(v), u250: new Float32Array(n), v250: new Float32Array(n) };
};

describe('synthetic radar: one core', () => {
  it('finds none in a flat, smooth cold anvil however cold, nor in yellow low cloud', () => {
    expect(coreStrength(features({ tK: 200, ringDiffK: 0.5, sigmaK: 0.4 }))).toBe(0);
    expect(coreStrength(features({ tK: 268, ringDiffK: 25, sigmaK: 6 }))).toBe(0);
  });

  it('finds one under a dome standing out of its cloud, and under a top that bloomed', () => {
    expect(coreStrength(features({ tK: 225, ringDiffK: 18, sigmaK: 5 }))).toBeGreaterThan(0.9);
    expect(coreStrength(features({ tK: 235, coolingK: -20 }))).toBe(1);
  });

  it('wears away an anvil tail downwind of its core', () => {
    const base = { tK: 230, ringDiffK: 9, sigmaK: 3 };
    expect(coreStrength(features({ ...base, tailK: 8 }))).toBeLessThan(coreStrength(features(base)));
  });

  it('draws a core about 5 km wide, lightning rain only on cloud', () => {
    const core = { cloudy: true, coreDbz: 40, along: 0, lightning: 0 };
    expect(classifyPixel({ ...core, acrossKm: 0 })).toBe(40);
    expect(classifyPixel({ ...core, acrossKm: 2 })).toBeGreaterThan(30);
    expect(classifyPixel({ ...core, acrossKm: 2.6 })).toBe(0);
    expect(classifyPixel({ cloudy: true, coreDbz: 0, acrossKm: 0, along: 0, lightning: 2 })).toBeGreaterThanOrEqual(25);
    expect(classifyPixel({ cloudy: false, coreDbz: 0, acrossKm: 0, along: 0, lightning: 9 })).toBe(0);
  });

  it('can be tuned', () => {
    const cfg = tuneConfig(SYNTHETIC_RADAR_CONFIG, { core: { widthKm: 4 } });
    expect(cfg.core.widthKm).toBe(4);
    expect(cfg.core.spacingKm).toBe(SYNTHETIC_RADAR_CONFIG.core.spacingKm);
    expect(SYNTHETIC_RADAR_CONFIG.core.widthKm).toBe(5);
  });
});

describe('synthetic radar: the grid', () => {
  it('rains only at the core of a popup, not over its whole cloud, and never under a wide flat anvil', () => {
    const ir = grid((x, y) => {
      if (x < 50) {
        const d = Math.hypot(x - 20, y - 55);
        return d < 2 ? 215 : d < 8 ? 248 : 285; // a popup (cold top) in a cloud 50 km wide, a lukewarm 248 K around it, over warm low cloud
      }
      return x > 60 && x < 108 && y > 5 && y < 105 ? 205 : 290; // a flat anvil sheet 140 km wide
    });
    const out = synthesizeRadar({ w: W, h: H, box, ir });
    expect(maxIn(out, 18, 53, 22, 57)).toBeGreaterThanOrEqual(30);
    expect(maxIn(out, 12, 47, 14, 49)).toBe(0); // the popup's cloud away from the core
    expect(maxIn(out, 70, 15, 98, 95)).toBe(0);
    expect(rainArea(out)).toBeLessThan(70); // one 5 km core and its light rim on the ground (a few km), not the cloud's 200
    // a light rim (2 to 3 km) around the core on the ground
    const sub = out.w / W;
    let light = 0;
    for (let y = 48 * sub; y < 62 * sub; y++) for (let x = 13 * sub; x < 28 * sub; x++) { const v = out.dbz4[y * out.w + x] / 4; if (v > 0 && v <= 22) light++; }
    expect(light).toBeGreaterThan(0);
  });

  it('marks where a top bloomed and carries it with the 850 hPa wind, while the anvil spreading out is none', () => {
    // 30 minutes ago a tower bloomed at x 30; since then its anvil spread out about 12 km a frame, as cold as the tower
    const disc = (r: number, t: number) => grid((x, y) => (Math.hypot(x - 30, y - 55) < r ? t : 285));
    const wind = steady(5, 0); // 850 hPa: 5 m/s from the west, 9 km in 30 minutes
    const history = [{ ir: disc(5, 200), minutesAgo: 15 }, { ir: disc(2, 205), minutesAgo: 30 }, { ir: disc(0, 285), minutesAgo: 45 }];
    const out = synthesizeRadar({ w: W, h: H, box, ir: disc(9, 200), wind, history });
    const bloomed = out.cores.filter(c => c.kind === 'bloom');
    const first = bloomed.find(c => c.ageMin === 30);
    expect(first).toBeDefined();
    expect(first!.lon).toBeGreaterThan(lonOf(30) + 0.05); // moved east with the wind
    // every bloom is the tower or its first minutes, near it: none out on the anvil
    for (const c of bloomed) expect(Math.abs(c.lon - lonOf(32))).toBeLessThan(0.1);
    expect(out.cores.filter(c => c.kind === 'dome').length).toBe(0); // the flat anvil's edge is no dome
    expect(maxIn(out, 32, 53, 37, 57)).toBeGreaterThan(30);
    expect(maxIn(out, 22, 61, 26, 63)).toBeLessThanOrEqual(30); // the rest of the anvil: light rain at most (as the radar shows under an anvil)
  });

  it('rains over the shape that bloomed: a long cell stays long, lighter at its edge than at its core', () => {
    // a strip 6 km wide and 24 km long cooled from 250 K to 205 K in the last frame
    const strip = (x: number, y: number) => Math.abs(x - 40) <= 1 && Math.abs(y - 55) <= 4;
    const before = grid((x, y) => (strip(x, y) ? 250 : 275));
    const now = grid((x, y) => (strip(x, y) ? (Math.abs(y - 55) <= 1 ? 205 : 212) : 275));
    const out = synthesizeRadar({ w: W, h: H, box, ir: now, history: [{ ir: before, minutesAgo: 15 }] });
    expect(maxIn(out, 39, 58, 41, 59)).toBeGreaterThan(20); // the strip's ends rain too...
    expect(maxIn(out, 39, 58, 41, 59)).toBeLessThan(maxIn(out, 39, 54, 41, 56)); // ...less than its core
    expect(maxIn(out, 34, 50, 35, 60)).toBe(0); // and not beside it
  });

  it('puts heavy cores where the lightning crowds, a little rain around the rest, none on clear sky', () => {
    const ir = grid(x => (x < 55 ? 205 : 300));
    const strikes = [
      ...Array.from({ length: 6 }, (_, k) => ({ lat: latOf(55), lon: lonOf(25 + k * 0.1), ageS: 60 })),
      { lat: latOf(20), lon: lonOf(25), ageS: 600 }, // a lone old stroke: no rain
      { lat: latOf(55), lon: lonOf(85), ageS: 60 },
      { lat: latOf(55), lon: lonOf(85.2), ageS: 60 },
    ];
    const out = synthesizeRadar({ w: W, h: H, box, ir, strikes }, tuneConfig(SYNTHETIC_RADAR_CONFIG, { texture: { amplitudeDbz: 0 } }));
    expect(maxIn(out, 23, 53, 28, 57)).toBeGreaterThanOrEqual(47);
    expect(maxIn(out, 22, 17, 28, 23)).toBe(0);
    expect(maxIn(out, 75, 40, 100, 70)).toBe(0);
    expect(out.cores.filter(c => c.kind === 'lightning').length).toBe(1);
    expect(out.stats.strikes).toBe(9);
  });

  it('is shifted to match the real radar where both see rain', () => {
    const ir = grid((x, y) => { const d = Math.hypot((x % 16) - 8, (y % 16) - 8); return d < 1.5 ? 212 : d < 4.5 ? 235 : 285; }); // many cells near a radar
    const plain = synthesizeRadar({ w: W, h: H, box, ir });
    const field = new Uint8Array(200 * 200).fill(Math.round(((55 - 12) / 9.6 / 6) * 255)); // the radar sees 55 dBZ everywhere
    const radar = { field, width: 200, height: 200, box, maxIntensity: 6, discs: [{ lat: latOf(55), lng: lonOf(55), rangeKm: 250 }] };
    const matched = synthesizeRadar({ w: W, h: H, box, ir, radar });
    expect(matched.stats.pairs).toBeGreaterThan(150);
    expect(matched.stats.offsetDb).toBeGreaterThan(0);
    expect(matched.stats.offsetDb).toBeLessThanOrEqual(8);
    expect(maxIn(matched, 0, 0, W - 1, H - 1)).toBeGreaterThan(maxIn(plain, 0, 0, W - 1, H - 1));
  });
});
