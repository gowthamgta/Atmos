import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { IMD_RADAR_STATIONS } from '../domain/models/radar.model';
import {
  COVERAGE_GOOD,
  COVERAGE_LIMITED,
  COVERAGE_NONE,
  COVERAGE_POOR,
  CoverageGrid,
  CoverageMeta,
  FAINTEST_KEPT,
  coverageAt,
  coverageCorners,
  coverageHaze,
  hideFaintFarEchoes,
  parseCoverageMeta,
} from './radar-coverage';

/** Pixels of an 8-bit grayscale, non-interlaced PNG (all that the baked file is): inflate, then undo the row filters. */
function decodeGrayPng(png: Buffer, width: number, height: number): Uint8Array {
  let offset = 8;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('latin1');
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)];
    for (let x = 0; x < width; x++) {
      const left = x > 0 ? out[y * width + x - 1] : 0;
      const up = y > 0 ? out[(y - 1) * width + x] : 0;
      const upLeft = x > 0 && y > 0 ? out[(y - 1) * width + x - 1] : 0;
      const v = raw[y * (width + 1) + 1 + x];
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(up - upLeft);
        const pb = Math.abs(left - upLeft);
        const pc = Math.abs(left + up - 2 * upLeft);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[y * width + x] = (v + add) & 255;
    }
  }
  return out;
}


const META: CoverageMeta = {
  version: 1, south: 10, north: 11, west: 78, east: 79, step: 0.5, nx: 3, ny: 3,
  assumptions: { lowestSweepDeg: 0.5, beamWidthDeg: { 'S-Band': 1 }, antennaM: 30 }, stations: [],
};
/** Row 0 is the north edge:  3 0 .  /  2 1 .  /  . . . */
const GRID: CoverageGrid = {
  meta: META,
  classes: Uint8Array.from([COVERAGE_GOOD, COVERAGE_NONE, 0, COVERAGE_LIMITED, COVERAGE_POOR, 0, 0, 0, 0]),
};

describe('reading the coverage grid', () => {
  it('gives the class of the nearest cell, north row first', () => {
    expect(coverageAt(GRID, 11, 78)).toBe(COVERAGE_GOOD);
    expect(coverageAt(GRID, 11.1, 78.1)).toBe(COVERAGE_GOOD);          // still nearest to the north-west cell
    expect(coverageAt(GRID, 10.5, 78)).toBe(COVERAGE_LIMITED);
    expect(coverageAt(GRID, 10.5, 78.5)).toBe(COVERAGE_POOR);
  });

  it('is "no radar" outside the box', () => {
    expect(coverageAt(GRID, 20, 78)).toBe(COVERAGE_NONE);
    expect(coverageAt(GRID, 10.5, 70)).toBe(COVERAGE_NONE);
  });

  it('puts the corners half a step beyond the cell centres', () => {
    expect(coverageCorners(META)).toEqual([[77.75, 11.25], [79.25, 11.25], [79.25, 9.75], [77.75, 9.75]]);
  });
});

describe('the haze picture', () => {
  it('is clear over the best class and denser the worse the class', () => {
    const { width, height, pixels } = coverageHaze(GRID, 60);
    expect(pixels.length).toBe(width * height * 4);
    const alphaAtLatLon = (lat: number, lon: number) => {
      const [[w, n], , [e, s]] = coverageCorners(META);
      const x = Math.min(width - 1, Math.floor(((lon - w) / (e - w)) * width));
      // rows are evenly spaced in Mercator, close to linear over one degree
      const y = Math.min(height - 1, Math.floor(((n - lat) / (n - s)) * height));
      return pixels[(y * width + x) * 4 + 3];
    };
    const good = alphaAtLatLon(11, 78);
    const limited = alphaAtLatLon(10.5, 78);
    const poor = alphaAtLatLon(10.5, 78.5);
    const none = alphaAtLatLon(11, 78.5);
    expect(good).toBeLessThan(limited);
    expect(limited).toBeLessThan(poor);
    expect(poor).toBeLessThan(none);
  });

  it('has square-ish pixels: its height follows the Mercator shape of the box', () => {
    const { width, height } = coverageHaze(GRID, 300);
    // 1.5 degrees of longitude by 1.5 degrees of latitude at about 10.5 N: a little taller than wide (1 / cos 10.5 deg)
    expect(height / width).toBeGreaterThan(1.0);
    expect(height / width).toBeLessThan(1.04);
  });
});

describe('the baked file', () => {
  const meta = parseCoverageMeta(JSON.parse(readFileSync('public/data/radar-coverage.json', 'utf8')));

  it('is for exactly the radars the app has (add a radar, bake the file again: pipeline/build_radar_coverage.py)', () => {
    expect(meta).not.toBeNull();
    const baked = meta!.stations.map(s => s.id).sort();
    expect(baked).toEqual(IMD_RADAR_STATIONS.map(s => s.id).sort());
    for (const s of meta!.stations) {
      const app = IMD_RADAR_STATIONS.find(x => x.id === s.id)!;
      expect(s.lat).toBeCloseTo(app.lat, 4);
      expect(s.lng).toBeCloseTo(app.lng, 4);
      expect(s.band).toBe(app.band);
    }
  });

  it('has the site of every radar seen well, and nothing at the corners of the box', () => {
    const grid: CoverageGrid = { meta: meta!, classes: decodeGrayPng(readFileSync('public/data/radar-coverage.png'), meta!.nx, meta!.ny) };
    for (const s of meta!.stations) expect(coverageAt(grid, s.lat, s.lng), s.id).toBe(COVERAGE_GOOD);
    expect(coverageAt(grid, meta!.south, meta!.west)).toBe(COVERAGE_NONE);
    expect(coverageAt(grid, meta!.north, meta!.east)).toBe(COVERAGE_NONE);
    // the classes are all there: the beam rises with distance, so some places are partly or poorly seen
    const seen = new Set(grid.classes);
    for (const c of [COVERAGE_NONE, COVERAGE_POOR, COVERAGE_LIMITED, COVERAGE_GOOD]) expect(seen.has(c), 'class ' + c).toBe(true);
  });

  it('sees less of the ground the farther it is from a radar (inland from Chennai)', () => {
    const grid: CoverageGrid = { meta: meta!, classes: decodeGrayPng(readFileSync('public/data/radar-coverage.png'), meta!.nx, meta!.ny) };
    const chennai = IMD_RADAR_STATIONS.find(s => s.id === 'chennai')!;
    const at = (km: number) => coverageAt(grid, chennai.lat, chennai.lng - km / (111.32 * Math.cos((chennai.lat * Math.PI) / 180)));
    expect(at(40)).toBeGreaterThanOrEqual(at(130));
    expect(at(130)).toBeGreaterThanOrEqual(at(230));
  });
});

describe('leaving out faint echoes where the radars see little', () => {
  // the 3 x 3 grid again, with a 3 x 3 picture laid exactly on its cells: good, none / limited, poor / (none row)
  const CORNERS = [[78, 11], [79, 11], [79, 10], [78, 10]] as const;
  const at = (out: Uint8Array, x: number, y: number) => out[y * 3 + x];

  it('keeps everything close to a radar, and fades a faint echo away where the beam is high or blocked', () => {
    const faint = new Uint8Array(9).fill(40);                                  // about 0.94 on the intensity scale (21 dBZ)
    const out = hideFaintFarEchoes(faint, 3, 3, CORNERS, GRID);
    expect(at(out, 0, 0)).toBe(40);                                            // seen well: kept
    expect(at(out, 0, 1)).toBe(40);                                            // partly seen: the limit is 0.9 (38), so it stays
    expect(at(out, 1, 0)).toBe(0);                                             // no radar: gone
    expect(at(out, 1, 1)).toBe(0);                                             // mostly missed: gone
  });

  it('keeps firm echoes everywhere and fades the ones near the limit softly', () => {
    const firm = hideFaintFarEchoes(new Uint8Array(9).fill(200), 3, 3, CORNERS, GRID);
    expect([...firm].every(b => b === 200)).toBe(true);
    const mid = hideFaintFarEchoes(new Uint8Array(9).fill(50), 3, 3, CORNERS, GRID);
    expect(at(mid, 1, 1)).toBeGreaterThan(0);                                  // between 70% of the limit (41.7) and the limit (59.5): faded, not cut
    expect(at(mid, 1, 1)).toBeLessThan(50);
    expect(at(mid, 0, 0)).toBe(50);
  });

  it('leaves no echo where there was none, and does not change the picture it was given', () => {
    const input = new Uint8Array(9);
    input[4] = 40;
    const copy = new Uint8Array(input);
    const out = hideFaintFarEchoes(input, 3, 3, CORNERS, GRID);
    expect(input).toEqual(copy);
    expect(out[0]).toBe(0);
    expect(out[4]).toBe(0);
  });

  it('treats a place outside the baked box as unseen', () => {
    // a picture reaching two degrees west of the grid: its first column is outside the box
    const wide = [[76, 11], [79, 11], [79, 10], [76, 10]] as const;
    const out = hideFaintFarEchoes(new Uint8Array(4 * 3).fill(40), 4, 3, wide, GRID);
    expect(out[0]).toBe(0);                                                    // 76 E: outside the box
    expect(out[2]).toBe(40);                                                   // 78 E, 11 N: the grid's best cell
  });

  it('has a limit for every class, the best one needing none', () => {
    expect(FAINTEST_KEPT[COVERAGE_GOOD]).toBe(0);
    expect(FAINTEST_KEPT[COVERAGE_LIMITED]).toBeLessThan(FAINTEST_KEPT[COVERAGE_POOR]);
    expect(FAINTEST_KEPT[COVERAGE_NONE]).toBe(FAINTEST_KEPT[COVERAGE_POOR]);
  });
});
