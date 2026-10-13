import { describe, expect, it } from 'vitest';
import { kmhToDegPerHour, uniformMotionField } from './radar-motion';
import {
  FieldBox,
  TrackFrame,
  aboutMinutes,
  advectField,
  describeRainEta,
  gaussianBlurRect,
  makeSampler,
  nowcastPicture,
  nowcastSigmaKm,
  overlapShare,
  rainEta,
  scoreRain,
  strengthWord,
  trackBox,
  verifyNowcast,
} from './radar-nowcast';
import { TrackingGrid } from './storm-tracking';

/** 101 x 101 pixels over one degree: 0.01 degree (about 1.1 km) a pixel. */
const BOX: FieldBox = { west: 78, north: 11, east: 79, south: 10, width: 101, height: 101 };
const MOTION_BOX = { south: 10, west: 78, north: 11, east: 79 };

function blob(w: number, h: number, cx: number, cy: number, sigma: number, amp = 100): Float32Array {
  const f = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] = amp * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma * sigma));
  return f;
}

function centroid(f: ArrayLike<number>, w: number, h: number): { x: number; y: number; sum: number } {
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = f[y * w + x]; sum += v; sx += v * x; sy += v * y; }
  return { x: sx / sum, y: sy / sum, sum };
}

describe('sliding a picture along the motion', () => {
  it('moves a shower east by the distance the rain travels', () => {
    const src = blob(101, 101, 30, 50, 3);
    const east = uniformMotionField(MOTION_BOX, 0.6, 0);                      // 0.6 degrees an hour: 20 minutes is 0.2 degrees, 20 pixels
    const out = advectField(src, BOX, east, 20);
    const c = centroid(out.field, out.width, out.height);
    expect(c.x).toBeCloseTo(50, 0);
    expect(c.y).toBeCloseTo(50, 0);
    expect(c.sum / centroid(src, 101, 101).sum).toBeCloseTo(1, 1);          // nothing lost or made on the way
  });

  it('moves it north (up the picture), and diagonally', () => {
    const north = advectField(blob(101, 101, 50, 70, 3), BOX, uniformMotionField(MOTION_BOX, 0, 0.6), 20);
    const n = centroid(north.field, north.width, north.height);
    expect(n.x).toBeCloseTo(50, 0);
    expect(n.y).toBeCloseTo(50, 0);
    const both = advectField(blob(101, 101, 30, 70, 3), BOX, uniformMotionField(MOTION_BOX, 0.3, 0.3), 40);
    const b = centroid(both.field, both.width, both.height);
    expect(b.x).toBeCloseTo(50, 0);
    expect(b.y).toBeCloseTo(50, 0);
  });

  it('leaves the picture as it is when the rain does not move, and empties what is carried off the edge', () => {
    const src = blob(101, 101, 50, 50, 3);
    const same = advectField(src, BOX, uniformMotionField(MOTION_BOX, 0, 0), 30);
    expect(Math.abs(centroid(same.field, 101, 101).sum - centroid(src, 101, 101).sum)).toBeLessThan(1e-3 * centroid(src, 101, 101).sum);
    const gone = advectField(blob(101, 101, 95, 50, 2), BOX, uniformMotionField(MOTION_BOX, 0.6, 0), 30);   // 30 pixels east: out of the picture
    expect(centroid(gone.field, gone.width, gone.height).sum).toBeLessThan(1);
  });

  it('can be made coarser', () => {
    const out = advectField(blob(101, 101, 50, 50, 3), BOX, uniformMotionField(MOTION_BOX, 0, 0), 10, 2);
    expect(out.width).toBe(51);
    expect(out.height).toBe(51);
    expect(centroid(out.field, out.width, out.height).x).toBeCloseTo(25, 0);
  });
});

describe('the blur', () => {
  it('spreads a peak out and keeps what the field holds', () => {
    const src = blob(101, 101, 50, 50, 2);
    const soft = gaussianBlurRect(src, 101, 101, 4);
    expect(Math.max(...soft)).toBeLessThan(Math.max(...src));
    expect(centroid(soft, 101, 101).sum).toBeCloseTo(centroid(src, 101, 101).sum, -1);
    expect(centroid(soft, 101, 101).x).toBeCloseTo(50, 3);
  });

  it('is a copy when the blur is too small to matter, and works on a field that is not square', () => {
    const src = blob(60, 30, 20, 10, 2);
    const same = gaussianBlurRect(src, 60, 30, 0.2);
    expect(same).toEqual(src);
    expect(same).not.toBe(src);
    const soft = gaussianBlurRect(src, 60, 30, 3);
    expect(soft.length).toBe(60 * 30);
    expect(centroid(soft, 60, 30).y).toBeCloseTo(10, 1);
  });

  it('is softer the further ahead the picture looks', () => {
    expect(nowcastSigmaKm(10)).toBeLessThan(nowcastSigmaKm(30));
    expect(nowcastSigmaKm(30)).toBeLessThan(nowcastSigmaKm(60));
  });
});

describe('the picture ahead, as the map draws it', () => {
  it('is bytes at half the size, with the rain where it will be', () => {
    const bytes = new Uint8Array(101 * 101);
    const src = blob(101, 101, 30, 50, 3, 200);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(src[i]);
    const out = nowcastPicture(bytes, BOX, uniformMotionField(MOTION_BOX, 0.6, 0), 20, 2);
    expect(out.field).toBeInstanceOf(Uint8Array);
    expect(out.width).toBe(51);
    const c = centroid(out.field, out.width, out.height);
    expect(c.x).toBeCloseTo(25, 0);
    expect(Math.max(...out.field)).toBeLessThanOrEqual(200);
    expect(Math.max(...out.field)).toBeGreaterThan(60);
  });
});

describe('scoring a guess', () => {
  it('counts hits, misses and false alarms against the rain threshold', () => {
    const real = [0, 2, 2, 0, 3, 0];
    const guess = [0, 2, 0, 2, 3, 0];
    expect(scoreRain(guess, real)).toEqual({ hits: 2, misses: 1, falseAlarms: 1 });
    expect(overlapShare({ hits: 2, misses: 1, falseAlarms: 1 })).toBeCloseTo(0.5, 6);
    expect(overlapShare({ hits: 0, misses: 0, falseAlarms: 0 })).toBeNull();
  });
});

describe('trying the nowcast on the pictures there are', () => {
  const GRID: TrackingGrid = { west: 78, north: 12, step: 0.036, nx: 80, ny: 80 };
  const BOX_G = { south: 12 - 80 * 0.036, west: 78, north: 12, east: 78 + 80 * 0.036 };

  /** A storm of radius 9 cells that moves `cellsPerMin` east, on the tracking grid; time in minutes. */
  function storm(minute: number, cellsPerMin: number): TrackFrame {
    const track = new Float32Array(80 * 80);
    const cx = 20 + cellsPerMin * minute;
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) if ((x - cx) ** 2 + (y - 40) ** 2 <= 81) track[y * 80 + x] = 3;
    return { timeMs: minute * 60_000, track };
  }
  const frames = (speed: number) => [0, 10, 20, 30, 40, 50, 60].map(m => storm(m, speed));

  it('does better than a picture that does not move when the rain moves', () => {
    const skill = verifyNowcast(frames(0.2), GRID, BOX_G, 30)!;
    expect(skill).not.toBeNull();
    expect(skill.leadMin).toBe(30);
    expect(skill.cases).toBe(2);                                                 // the two pictures that have one 30 minutes before and another 15 to 40 minutes before that
    expect(skill.nowcast).toBeGreaterThan(0.75);
    expect(skill.nowcast).toBeGreaterThan(skill.still + 0.2);
  });

  it('does as well as a still picture when nothing moves', () => {
    const skill = verifyNowcast(frames(0), GRID, BOX_G, 30)!;
    expect(skill.nowcast).toBeGreaterThan(0.95);
    expect(Math.abs(skill.nowcast - skill.still)).toBeLessThan(0.05);
  });

  it('says nothing when there are too few pictures or no rain to judge by', () => {
    expect(verifyNowcast(frames(0.2).slice(0, 2), GRID, BOX_G, 30)).toBeNull();
    const dry = [0, 10, 20, 30, 40, 50, 60].map(m => ({ timeMs: m * 60_000, track: new Float32Array(80 * 80) }));
    expect(verifyNowcast(dry, GRID, BOX_G, 30)).toBeNull();
  });

  it('puts the tracking grid on a box by its cell centres', () => {
    const b = trackBox(GRID);
    expect(b.west).toBeCloseTo(78.018, 6);
    expect(b.north).toBeCloseTo(11.982, 6);
    expect(b.east - b.west).toBeCloseTo(79 * 0.036, 6);
    expect(b.width).toBe(80);
  });
});

describe('when rain reaches a place', () => {
  const LAT = 10;
  const LON = 78;
  const kmToLon = (km: number) => km / (111.32 * Math.cos((LAT * Math.PI) / 180));
  const east30 = kmhToDegPerHour(30, 90, LAT);
  const eastward = uniformMotionField({ south: 8, west: 76, north: 12, east: 80 }, east30.u, east30.v);

  it('says when the edge of a rain area 30 km upwind will arrive, a little early (it looks ahead with a margin)', () => {
    const edge = LON - kmToLon(30);
    const rain = (lat: number, lon: number) => (lon <= edge ? 2.5 : 0);        // rain to the west of the edge, moving east at 30 km/h
    const eta = rainEta(rain, eastward, LAT, LON);
    expect(eta.status).toBe('approaching');
    expect(eta.minutes).toBeGreaterThanOrEqual(45);
    expect(eta.minutes).toBeLessThanOrEqual(60);
    expect(eta.peak).toBeGreaterThanOrEqual(2.5);
  });

  it('says when the rain over the place will end', () => {
    const band = (lat: number, lon: number) => (lon >= LON - kmToLon(10) && lon <= LON + kmToLon(5) ? 2 : 0);      // its back edge is 10 km upwind: it passes in about 20 minutes
    const eta = rainEta(band, eastward, LAT, LON);
    expect(eta.status).toBe('clearing');
    expect(eta.minutes).toBeGreaterThanOrEqual(15);
    expect(eta.minutes).toBeLessThanOrEqual(40);
  });

  it('is dry when the rain is out of reach, and keeps raining when it is all around', () => {
    expect(rainEta(() => 0, eastward, LAT, LON).status).toBe('dry');
    const far = (lat: number, lon: number) => (lon <= LON - kmToLon(300) ? 3 : 0);          // 300 km away: 10 hours at 30 km/h
    expect(rainEta(far, eastward, LAT, LON).status).toBe('dry');
    const everywhere = rainEta(() => 2, eastward, LAT, LON);
    expect(everywhere.status).toBe('raining');
    expect(everywhere.minutes).toBeNull();
  });

  it('does not promise rain that is not moving towards the place', () => {
    const still = uniformMotionField({ south: 8, west: 76, north: 12, east: 80 }, 0, 0);
    const edge = LON - kmToLon(30);
    expect(rainEta((lat, lon) => (lon <= edge ? 2.5 : 0), still, LAT, LON).status).toBe('dry');
  });

  it('names the strength by the radar scale', () => {
    expect(strengthWord(1.2)).toBe('light');
    expect(strengthWord(2.4)).toBe('moderate');
    expect(strengthWord(3.2)).toBe('heavy');
  });
});

describe('reading the picture at a place and putting the rain into words', () => {
  const COORDS = [[78, 11], [79, 11], [79, 10], [78, 10]] as const;

  it('reads a byte picture bilinearly on the 0 to 6 scale, and nothing outside it', () => {
    const bytes = new Uint8Array(3 * 3);
    bytes[4] = 255;                                                  // the centre pixel: intensity 6
    const at = makeSampler(bytes, 3, 3, COORDS);
    expect(at(10.5, 78.5)).toBeCloseTo(6, 6);
    expect(at(10.75, 78.5)).toBeCloseTo(3, 6);                       // half way to the next pixel up
    expect(at(11, 78)).toBeCloseTo(0, 6);
    expect(at(12, 78.5)).toBe(0);
    expect(at(10.5, 77)).toBe(0);
  });

  it('rounds the time to five minutes, and says "a few minutes" when it is close', () => {
    expect(aboutMinutes(5)).toBe('a few minutes');
    expect(aboutMinutes(7)).toBe('a few minutes');
    expect(aboutMinutes(23)).toBe('25 min');
    expect(aboutMinutes(60)).toBe('60 min');
  });

  it('writes one line for each case', () => {
    expect(describeRainEta({ status: 'dry', minutes: null, peak: 0 })).toEqual({ text: 'No rain on the radar in the next 90 min', wet: false });
    expect(describeRainEta({ status: 'approaching', minutes: 25, peak: 2.4 })).toEqual({ text: 'Rain in 25 min · moderate', wet: true });
    expect(describeRainEta({ status: 'approaching', minutes: 5, peak: 3.5 }).text).toBe('Rain in a few minutes · heavy');
    expect(describeRainEta({ status: 'clearing', minutes: 30, peak: 1.5 }).text).toBe('Raining now (light) · easing in 30 min');
    expect(describeRainEta({ status: 'raining', minutes: null, peak: 2.1 }).text).toBe('Raining now (moderate) · no break in the next 90 min');
  });
});
