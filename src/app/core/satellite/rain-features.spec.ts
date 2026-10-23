import { MISSING, PairRadar, RAIN_FEATURES, RainModel, collectPairs, featureField, modelOrder, predictDbz, treesValue } from './rain-features';
import { synthesizeRadar } from './synthetic-radar';
import fixture from './rain-model.fixture.json';

// about 3 km a pixel over South India, as the data pack
const box = { west: 78, east: 81, south: 10, north: 13 };
const W = 110, H = 110;
const grid = (fill: (x: number, y: number) => number): Float32Array => {
  const a = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = fill(x, y);
  return a;
};
const at = (name: (typeof RAIN_FEATURES)[number]) => RAIN_FEATURES.indexOf(name);
/** A cold dome (205 K) 10 km across in a 240 K cloud 60 km across, on 295 K ground. */
const dome = grid((x, y) => {
  const r = Math.hypot(x - 55, y - 55);
  return r < 3 ? 205 : r < 20 ? 240 : 295;
});

describe('rain features', () => {
  it('reads a dome, its patch and the ground', () => {
    const f = featureField({ w: W, h: H, box, ir: dome });
    const x = new Float32Array(RAIN_FEATURES.length);
    f.fill(55 * W + 55, x);
    expect(x[at('t108')]).toBe(205);
    expect(x[at('ring')]).toBeGreaterThan(30); // colder than the cloud 15 to 25 km around
    expect(x[at('min250')]).toBe(205);
    expect(x[at('area250')]).toBeGreaterThan(3); // log10 of km2: the 40 km wide cloud
    expect(x[at('cool15')]).toBe(MISSING); // no frame before
    expect(x[at('u850')]).toBe(MISSING); // no wind
    expect(f.inDomain(55 * W + 55)).toBe(true);
    expect(f.inDomain(5 * W + 5)).toBe(false); // the ground
  });

  it('sees a top bloom and the lightning around it', () => {
    const before = grid((x, y) => (Math.hypot(x - 55, y - 55) < 20 ? 262 : 295));
    const f = featureField({
      w: W, h: H, box, ir: dome, history: [{ ir: before, minutesAgo: 15 }],
      strikes: [{ lat: 11.5, lon: 79.5, ageS: 60 }, { lat: 11.51, lon: 79.5, ageS: 120 }],
    });
    const x = new Float32Array(RAIN_FEATURES.length);
    f.fill(55 * W + 55, x);
    expect(x[at('cool15')]).toBeLessThan(-40);
    expect(x[at('ltg30')]).toBeGreaterThan(1.5);
  });
});

/** A one-split model: rain where t108 is 230 K or colder, 40 dBZ. */
const stump = (approved = true): RainModel => ({
  version: 1,
  features: ['t108'],
  approved,
  maxTopK: 285,
  rainProb: 0.5,
  minDbz: 15,
  maxDbz: 60,
  rain: { base: 0, lr: 1, trees: [{ f: [0, -1, -1], t: [230, 0, 0], l: [1, -1, -1], r: [2, -1, -1], v: [0, 4, -4] }] },
  dbz: { base: 30, lr: 0.5, trees: [{ f: [-1], t: [0], l: [-1], r: [-1], v: [20] }] },
});

describe('the learned model', () => {
  it('walks its trees', () => {
    const m = stump();
    expect(treesValue(m.rain, [220])).toBe(4);
    expect(treesValue(m.rain, [240])).toBe(-4);
    expect(predictDbz(m, [220])).toBe(40);
    expect(predictDbz(m, [240])).toBe(0);
  });

  it('reads a model as pipeline/learn_rain.py wrote it (the same fixture its tests check)', () => {
    const m = fixture.model as unknown as RainModel;
    fixture.inputs.forEach((x, k) => expect(predictDbz(m, x)).toBeCloseTo(fixture.expected[k], 4));
  });

  it('is refused with an input it does not know', () => {
    expect(modelOrder({ ...stump(), features: ['t108', 'zz'] })).toBeNull();
    expect(Array.from(modelOrder(stump())!)).toEqual([0]);
  });

  it('draws the rain once approved, the hand-set rules until then', () => {
    const ir = grid((x, y) => (Math.hypot(x - 55, y - 55) < 12 ? 225 : 295));
    const learned = synthesizeRadar({ w: W, h: H, box, ir, model: stump() });
    expect(learned.stats.learned).toBe(true);
    const s = learned.w / W;
    expect(learned.dbz4[55 * s * learned.w + 55 * s] / 4).toBeGreaterThan(25);
    expect(learned.dbz4[5 * s * learned.w + 5 * s]).toBe(0);
    expect(synthesizeRadar({ w: W, h: H, box, ir, model: stump(false) }).stats.learned).toBe(false);
  });
});

describe('pairs', () => {
  it('pairs the satellite with the radar where it sees well, and samples the dry', () => {
    // a radar west of the dome seeing 45 dBZ over the dome and nothing elsewhere; its picture covers the whole box at 1 px per data pixel
    const field = new Uint8Array(W * H);
    for (let y = 50; y <= 60; y++) for (let x = 50; x <= 60; x++) field[y * W + x] = Math.round(((45 - 12) / 9.6 / 6) * 255);
    const radar: PairRadar = { field, width: W, height: H, box, maxIntensity: 6, discs: [{ lat: 11.5, lng: 78.9, rangeKm: 250 }], timeMs: 1000 };
    const ir = grid((x, y) => (Math.hypot(x - 55, y - 55) < 20 ? 230 : 280));
    const p = collectPairs({ w: W, h: H, box, ir }, radar, 0, null, { minRangeKm: 20, maxRangeKm: 250, rainDbz: 15, maxRainy: 2000, maxDry: 50 });
    const wet = p.cols['dbzMax'].map((v, i) => [v, p.cols['weight'][i]]).filter(([v]) => v >= 15);
    expect(wet.length).toBe(p.counts.rainy);
    expect(Math.max(...wet.map(([v]) => v))).toBeCloseTo(45, 0);
    expect(p.rows - wet.length).toBe(50);
    expect(p.cols['weight'][p.rows - 1]).toBeGreaterThan(1); // each dry one stands for several
    expect(p.cols['hand'][0]).toBe(MISSING);
    expect(p.radarTimeMs).toBe(1000);
    // the radar's own place (closer than 20 km) is left out
    const near = p.cols['lat'].some((la, i) => Math.hypot((la - 11.5) * 110.6, (p.cols['lon'][i] - 78.9) * 109) < 18);
    expect(near).toBe(false);
  });
});
