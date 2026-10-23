import { PixelFeatures, SYNTHETIC_RADAR_CONFIG, classifyPixel, synthesizeRadar, tuneConfig } from './synthetic-radar';

const pixel = (p: Partial<PixelFeatures>): PixelFeatures => ({
  tK: 230, ringDiffK: 0, sigmaK: 0, coolingK: NaN, tailK: 0, leadK: 0, cellRadiusKm: 0, cellScore: 0, coreProfile: 0, ridge: 0, subcoreK: 0,
  lightningCore: 0, lightningEnvelope: 0, gradientKPerKm: 0, ...p,
});

// a grid about 3 km a pixel over South India (the data pack's spacing)
const box = { west: 76, east: 79, south: 9, north: 12 };
const W = 110, H = 110;
const grid = (fill: (x: number, y: number) => number): Float32Array => {
  const a = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = fill(x, y);
  return a;
};
const dbzAt = (out: { dbz4: Uint8Array }, x: number, y: number): number => out.dbz4[y * W + x] / 4;
const maxIn = (out: { dbz4: Uint8Array }, x0: number, y0: number, x1: number, y1: number): number => {
  let m = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m = Math.max(m, dbzAt(out, x, y));
  return m;
};
const latOf = (y: number) => {
  const m0 = 0.5 - Math.log((1 + Math.sin(12 * Math.PI / 180)) / (1 - Math.sin(12 * Math.PI / 180))) / (4 * Math.PI);
  const m1 = 0.5 - Math.log((1 + Math.sin(9 * Math.PI / 180)) / (1 - Math.sin(9 * Math.PI / 180))) / (4 * Math.PI);
  const m = m0 + ((y + 0.5) / H) * (m1 - m0);
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * m))) * 180) / Math.PI;
};
const lonOf = (x: number) => box.west + ((x + 0.5) / W) * (box.east - box.west);

describe('synthetic radar: one pixel', () => {
  it('leaves a flat, smooth cold anvil out however cold it is', () => {
    const r = classifyPixel(pixel({ tK: 205, ringDiffK: 0.5, sigmaK: 0.4, cellRadiusKm: 30 }));
    expect(r.dbz).toBe(0);
    expect(r.category).toBe('anvil');
  });

  it('never rains from yellow low cloud or ground', () => {
    expect(classifyPixel(pixel({ tK: 272, ringDiffK: 20, sigmaK: 6, cellRadiusKm: 3, cellScore: 1, coreProfile: 1 })).dbz).toBe(0);
    expect(classifyPixel(pixel({ tK: 295, lightningCore: 3 })).dbz).toBe(0);
  });

  it('draws a small popup as a light core of 20 to 28 dBZ, a medium cell 28 to 36, and a lightning core 45 or more', () => {
    const popup = classifyPixel(pixel({ tK: 240, ringDiffK: 15, sigmaK: 5, cellRadiusKm: 3, cellScore: 1, coreProfile: 1 }));
    expect(popup.category).toBe('popup');
    expect(popup.dbz).toBeGreaterThanOrEqual(20);
    expect(popup.dbz).toBeLessThanOrEqual(28);
    const cell = classifyPixel(pixel({ tK: 225, ringDiffK: 15, sigmaK: 5, cellRadiusKm: 8, cellScore: 1, coreProfile: 1 }));
    expect(cell.category).toBe('cell');
    expect(cell.dbz).toBeGreaterThanOrEqual(28);
    expect(cell.dbz).toBeLessThanOrEqual(36);
    const storm = classifyPixel(pixel({ tK: 205, ringDiffK: 2, sigmaK: 1, lightningCore: 2, gradientKPerKm: 3 }));
    expect(storm.category).toBe('lightning');
    expect(storm.dbz).toBeGreaterThanOrEqual(45);
  });

  it('wears away an anvil tail downwind of its core', () => {
    const base = { tK: 230, ringDiffK: 7, sigmaK: 3, cellRadiusKm: 8, cellScore: 0.6, coreProfile: 0.5 };
    expect(classifyPixel(pixel({ ...base, tailK: 8 })).dbz).toBeLessThan(classifyPixel(pixel(base)).dbz);
  });

  it('can be tuned', () => {
    const cfg = tuneConfig(SYNTHETIC_RADAR_CONFIG, { cloud: { coreMaxK: 240 } });
    expect(cfg.cloud.coreMaxK).toBe(240);
    expect(cfg.cloud.topK).toBe(SYNTHETIC_RADAR_CONFIG.cloud.topK);
    expect(SYNTHETIC_RADAR_CONFIG.cloud.coreMaxK).toBe(248);
  });
});

describe('synthetic radar: the grid', () => {
  it('rains under an isolated cold dome in low cloud, not under a wide flat anvil', () => {
    const ir = grid((x, y) => {
      if (x < 50) return Math.hypot(x - 20, y - 55) < 4 ? 225 : 285; // a popup over yellow low cloud and ground
      return x > 60 && x < 108 && y > 5 && y < 105 ? 210 : 290; // a flat anvil sheet 140 km wide
    });
    const out = synthesizeRadar({ w: W, h: H, box, ir });
    expect(maxIn(out, 15, 50, 25, 60)).toBeGreaterThanOrEqual(20);
    expect(maxIn(out, 70, 15, 98, 95)).toBe(0);
    expect(maxIn(out, 0, 0, 10, 10)).toBe(0);
  });

  it('puts heavy cores where the lightning is on cloud, and none on clear sky', () => {
    const ir = grid(x => (x < 55 ? 215 : 300));
    const strikes = [
      { lat: latOf(55), lon: lonOf(25), ageS: 60 },
      { lat: latOf(55), lon: lonOf(25.5), ageS: 120 },
      { lat: latOf(55), lon: lonOf(85), ageS: 60 },
    ];
    const out = synthesizeRadar({ w: W, h: H, box, ir, strikes });
    expect(maxIn(out, 22, 52, 28, 58)).toBeGreaterThanOrEqual(45);
    expect(maxIn(out, 70, 40, 100, 70)).toBe(0);
    expect(out.stats.strikes).toBe(3);
  });

  it('marks a cloud that cooled since the frame before as a new popup', () => {
    const ir = grid((x, y) => (Math.hypot(x - 50, y - 50) < 3 ? 240 : 285));
    const irPrev = grid(() => 285);
    const out = synthesizeRadar({ w: W, h: H, box, ir, irPrev, prevMinutes: 15 });
    expect(out.stats.popups).toBe(1);
    expect(out.stats.usedPrevious).toBe(true);
  });

  it('is shifted to match the real radar where both see rain', () => {
    const ir = grid((x, y) => {
      const d = Math.hypot(x - 55, y - 55);
      return d < 30 && Math.hypot((x % 10) - 5, (y % 10) - 5) < 3 ? 225 : 285; // many popups near a radar
    });
    const plain = synthesizeRadar({ w: W, h: H, box, ir });
    const field = new Uint8Array(200 * 200).fill(Math.round(((45 - 12) / 9.6 / 6) * 255)); // the radar sees 45 dBZ everywhere
    const radar = { field, width: 200, height: 200, box, maxIntensity: 6, discs: [{ lat: latOf(55), lng: lonOf(55), rangeKm: 250 }] };
    const matched = synthesizeRadar({ w: W, h: H, box, ir, radar });
    expect(matched.stats.pairs).toBeGreaterThan(150);
    expect(matched.stats.offsetDb).toBeGreaterThan(0);
    expect(matched.stats.offsetDb).toBeLessThanOrEqual(8);
    expect(maxIn(matched, 0, 0, W - 1, H - 1)).toBeGreaterThan(maxIn(plain, 0, 0, W - 1, H - 1));
  });
});
