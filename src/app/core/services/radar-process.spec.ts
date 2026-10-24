import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMD_RADAR_STATIONS, RadarProductKey } from '../domain/models/radar.model';
import { RADAR_FIELD_SIZE, decodeLastGifFrame, fillOverlayGaps, layoutMatches, looksLikeRadar, processRadarPixels, removeMapDrawings } from './radar-process';
import { RadarProcessor } from './radar-processor';
import { RadarService } from './radar.service';
import { decodeRadarGif } from './radar-gif-decode';

/** FNV-1a of a field's bytes: the fields below were recorded from the implementation before it moved into a web worker. */
function hash(f: Float32Array): string {
  const u = new Uint32Array(f.buffer, f.byteOffset, f.length);
  let x = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) { x ^= u[i]; x = Math.imul(x, 0x01000193); }
  return (x >>> 0).toString(16);
}

// real IMD pictures (saved from mausam.imd.gov.in on 7 Oct 2026) and the hash of the field each must give
const CASES: [string, RadarProductKey, string, string][] = [
  ['karaikal', 'caz', 'karaikal-caz.gif', 'ae44ae5a'], // 24 Oct 2026: six lone pixels of 34-35 dBZ with no rain around taken off (removeMapDrawings)
];

function load(file: string): ArrayBuffer {
  const bytes = readFileSync(join(__dirname, 'testdata', file));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('radar picture processing (the same code runs in the worker and on the main thread)', () => {
  for (const [id, product, file, expected] of CASES) {
    const station = IMD_RADAR_STATIONS.find(s => s.id === id)!;
    const config = station.products[product];
    const options = { crop: config.crop, palette: config.palette, isTransparent: true, isXBand: station.band === 'X-Band' };

    it(`${id} ${product}: the intensity field is unchanged`, () => {
      const img = decodeLastGifFrame(new Uint8Array(load(file)))!;
      expect(layoutMatches(config.crop, img.w, img.h)).toBe(true);
      const field = processRadarPixels(img.rgba, img.w, img.h, options);
      expect(field.length).toBe(RADAR_FIELD_SIZE * RADAR_FIELD_SIZE);
      expect(hash(field)).toBe(expected);
    });

    it(`${id} ${product}: the processor gives the same field without a worker, and the service's result record`, async () => {
      const processor = new RadarProcessor();
      const still = await processor.still(load(file), options);
      expect(still.decoded && still.layoutOk).toBe(true);
      expect(hash(still.field!)).toBe(expected);
      const svc = TestBed.runInInjectionContext(() => new RadarService()) as any;
      const img = (await decodeRadarGif(load(file)))!;
      const res = svc.processRgba(station, product, config, true, img.rgba, img.w, img.h, null, true, false);
      expect(hash(res.fieldData.field)).toBe(expected);
    });
  }

  it('turns a picture that does not match the station layout into no field (the maintenance photo)', async () => {
    const processor = new RadarProcessor();
    const config = IMD_RADAR_STATIONS.find(s => s.id === 'karaikal')!.products.caz;
    // a picture smaller than the station's configured crop (here the crop asked for is 2000 px square)
    const still = await processor.still(load('karaikal-caz.gif'), { crop: { x: 0, y: 201, w: 2000, h: 2000 }, palette: config.palette, isTransparent: true, isXBand: false });
    expect(still.decoded).toBe(true);
    expect(still.layoutOk).toBe(false);
    expect(still.field).toBeNull();
  });

  it('hands the bytes back when the file is not a GIF', async () => {
    const processor = new RadarProcessor();
    const junk = new Uint8Array(2000).fill(7).buffer;
    const still = await processor.still(junk, { isTransparent: true, isXBand: false });
    expect(still.decoded).toBe(false);
    expect(still.bytes).toBeDefined();
  });
});

describe('radar intensity is kept as the picture gives it', () => {
  const karaikal = IMD_RADAR_STATIONS.find(st => st.id === 'karaikal')!.products.caz;
  const SEA: [number, number, number] = [190, 190, 190];
  const N = 120;

  /** A 120 x 120 picture of plain basemap with the given pixels painted on it (colours by [x, y]). */
  function picture(paint: Record<string, [number, number, number]>, background: [number, number, number] = SEA): Uint8Array {
    const rgba = new Uint8Array(N * N * 4);
    for (let i = 0; i < N * N; i++) rgba.set([...background, 255], i * 4);
    for (const [key, rgb] of Object.entries(paint)) {
      const [x, y] = key.split(',').map(Number);
      rgba.set([...rgb, 255], (y * N + x) * 4);
    }
    return rgba;
  }
  const block = (x0: number, y0: number, w: number, h: number, rgb: [number, number, number]) => {
    const p: Record<string, [number, number, number]> = {};
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) p[`${x},${y}`] = rgb;
    return p;
  };
  const run = (rgba: Uint8Array, palette: typeof karaikal.palette) => processRadarPixels(rgba, N, N, { palette, isTransparent: true, isXBand: false });
  const peak = (f: Float32Array) => f.reduce((m, v) => Math.max(m, v), 0);
  const dbz = (v: number) => 12 + 9.6 * v;

  it('shows a small strong cell at the strength the radar measured, not a blurred-down one', () => {
    // 4 x 4 picture pixels of 42 dBZ (the yellow of the scale of Karaikal), about 4 km across, inside a ring of 30 dBZ as every strong core is
    const out = run(picture({ ...block(48, 48, 8, 8, [0, 102, 255]), ...block(50, 50, 4, 4, [255, 229, 0]) }), karaikal.palette);
    expect(dbz(peak(out))).toBeGreaterThan(40);
    expect(dbz(peak(out))).toBeLessThan(45);
  });

  it('reads every shade of the smooth colour scale of Karaikal as its own intensity', () => {
    const weak = run(picture(block(50, 50, 6, 6, [58, 0, 160])), karaikal.palette);        // 20 to 22.7 dBZ: the bottom of the scale
    const middle = run(picture(block(50, 50, 6, 6, [0, 102, 255])), karaikal.palette);     // 30 dBZ
    const strong = run(picture({ ...block(47, 47, 10, 10, [0, 102, 255]), ...block(50, 50, 4, 4, [255, 110, 0]) }), karaikal.palette);     // 48 dBZ
    expect(dbz(peak(weak))).toBeGreaterThan(21);
    expect(dbz(peak(weak))).toBeLessThan(24);
    expect(dbz(peak(middle))).toBeGreaterThan(29);
    expect(dbz(peak(middle))).toBeLessThan(32);
    expect(dbz(peak(strong))).toBeGreaterThan(46);
    expect(dbz(peak(strong))).toBeLessThan(50);
  });

  it('keeps the whole core of a cell, not only its rim: a patch of white and yellow inside the blue of the cell', () => {
    // a 12 x 12 cell of 30 dBZ with a 6 x 6 core: white (39.5 dBZ) around a 2 x 2 heart of yellow (42 dBZ); white and yellow are colours the
    // relief map also uses, so they count only next to rain, and judged pixel by pixel the heart had no blue around it and was lost
    const out = run(picture({ ...block(44, 44, 12, 12, [0, 102, 255]), ...block(47, 47, 6, 6, [255, 253, 231]), ...block(49, 49, 2, 2, [255, 229, 0]) }), karaikal.palette);
    expect(dbz(peak(out))).toBeGreaterThan(41);
  });

  it('keeps a large core (over 1500 pixels) that is rain along most of its border but has land along the rest', () => {
    const land: [number, number, number] = [80, 160, 60];
    // a 50 x 50 core in a ring of blue, with the ring replaced by land along most of one side: about 80% of the core's border is rain
    const out = run(picture({ ...block(15, 30, 60, 60, [0, 102, 255]), ...block(20, 35, 50, 50, [255, 229, 0]), ...block(70, 48, 8, 37, land) }), karaikal.palette);
    expect(dbz(peak(out))).toBeGreaterThan(41);
  });

  it('keeps a core that one of the map lines drawn over the rain crosses', () => {
    const line: Record<string, [number, number, number]> = {};
    for (let x = 40; x < 60; x++) line[`${x},50`] = [0, 0, 0]; // a black line across the cell and its core
    const out = run(picture({ ...block(42, 42, 16, 16, [0, 102, 255]), ...block(46, 46, 8, 8, [255, 229, 0]), ...line }), karaikal.palette);
    expect(dbz(peak(out))).toBeGreaterThan(41);
  });

  it('leaves out a patch of those colours that the map surrounds (a label, a hill), however large', () => {
    expect(peak(run(picture(block(30, 30, 20, 6, [255, 253, 231])), karaikal.palette))).toBe(0);  // a white label on the map
    expect(peak(run(picture(block(10, 10, 60, 60, [255, 229, 0])), karaikal.palette))).toBe(0);   // a large yellow area: relief
  });

  it("does not take Chennai's sea (the light blue of 33.75 dBZ) for rain, and still keeps a cyan core in a cell beside it", () => {
    const chennai = IMD_RADAR_STATIONS.find(st => st.id === 'chennai')!.products.caz;
    const SEA_CNI: [number, number, number] = [102, 204, 255];
    const sea = run(picture({}, SEA_CNI), chennai.palette);
    expect(peak(sea)).toBe(0);
    const land: [number, number, number] = [80, 160, 60];
    const paint: Record<string, [number, number, number]> = {};
    for (let y = 0; y < N; y++) for (let x = 0; x < 60; x++) paint[`${x},${y}`] = land; // land on the left, the sea on the right
    const cell = run(picture({ ...paint, ...block(20, 40, 16, 16, [0, 102, 255]), ...block(24, 44, 8, 8, [153, 255, 255]) }, SEA_CNI), chennai.palette);
    expect(dbz(peak(cell))).toBeGreaterThan(35); // the cyan core (36.25 dBZ) is kept
  });

  it('keeps every echo, even a lone speck (no speck filter: all of the radar rain is shown)', () => {
    const cell = run(picture(block(60, 60, 3, 3, [0, 51, 255])), karaikal.palette);            // 26 dBZ, 3 x 3 pixels
    expect(peak(cell)).toBeGreaterThan(1.2);
    const speck = run(picture({ '60,60': [0, 51, 255] }), karaikal.palette);
    expect(peak(speck)).toBeGreaterThan(1.2);
  });

  it("reads Karaikal's PPI light rain (7 to 28 dBZ) and its strong cores from the PPI legend, and the PPZ with the 20 to 60 dBZ legend", () => {
    const ppi = IMD_RADAR_STATIONS.find(st => st.id === 'karaikal')!.products.ppi;
    const ppz = IMD_RADAR_STATIONS.find(st => st.id === 'karaikal')!.products.ppz;
    expect(ppi.palette).toBeDefined();
    expect(ppz.palette).toBeDefined();
    const light = run(picture(block(50, 50, 6, 6, [0, 43, 245])), ppi.palette!); // the blue at 17 dBZ on the PPI scale
    expect(dbz(peak(light))).toBeGreaterThan(14);
    expect(dbz(peak(light))).toBeLessThan(20);
    const strong = run(picture({ ...block(48, 48, 10, 10, [0, 120, 255]), ...block(51, 51, 4, 4, [255, 118, 0]) }), ppi.palette!); // orange: about 45 dBZ
    expect(dbz(peak(strong))).toBeGreaterThan(42);
    const ppzCell = run(picture({ ...block(48, 48, 10, 10, [0, 102, 255]), ...block(51, 51, 4, 4, [255, 229, 0]) }), ppz.palette!);
    expect(dbz(peak(ppzCell))).toBeGreaterThan(40);
  });
});

describe('IMD maintenance photo', () => {
  it('is told apart from a real sweep by the legend colours, though it is the size of a sweep', () => {
    const karaikal = IMD_RADAR_STATIONS.find(s => s.id === 'karaikal')!;
    const chennai = IMD_RADAR_STATIONS.find(s => s.id === 'chennai')!;
    const pic = (file: string) => decodeLastGifFrame(new Uint8Array(load(file)))!;
    const photo = pic('karaikal-maintenance.gif');
    expect(layoutMatches(karaikal.products.caz!.crop, photo.w, photo.h)).toBe(true);        // the size alone let it through
    expect(looksLikeRadar(photo.rgba, photo.w, photo.h, karaikal.products.caz!.palette)).toBe(false);
    for (const file of ['karaikal-caz.gif', 'karaikal-caz-stamp.gif']) {
      const p = pic(file);
      expect(looksLikeRadar(p.rgba, p.w, p.h, karaikal.products.caz!.palette)).toBe(true);
    }
    const c = pic('chennai-caz-stamp.gif');
    expect(looksLikeRadar(c.rgba, c.w, c.h, chennai.products.caz!.palette)).toBe(true);
  });
});

describe('the map drawn over the echoes', () => {
  const W = 40, H = 40;
  const grid = (f: (x: number, y: number) => number) => Float32Array.from({ length: W * H }, (_, i) => f(i % W, Math.floor(i / W)));

  it('fills a boundary line and a letter drawn across the rain, from the rain around them', () => {
    // rain at 3.0 over x < 30, a 2-pixel boundary line down x = 15, a 3 x 3 letter at (8, 8)
    const c = grid((x, y) => (x >= 30 || (x === 15 || x === 16) || (x >= 8 && x <= 10 && y >= 8 && y <= 10) ? 0 : 3));
    fillOverlayGaps(c, W, H, 4);
    expect(c[20 * W + 15]).toBeCloseTo(3, 5);
    expect(c[9 * W + 9]).toBeCloseTo(3, 5);
    expect(c[20 * W + 31]).toBe(0); // the rain's edge does not grow
  });

  it('does not bridge scattered specks of clutter', () => {
    const c = grid((x, y) => ((x % 4 === 0 && y % 5 === 0) ? 2 : 0));
    fillOverlayGaps(c, W, H, 4);
    expect(c[0 * W + 2]).toBe(0);
  });
});

describe('removeMapDrawings (map drawn in the legend\'s colours)', () => {
  // a legend of six levels: 1 and 2 are its weakest third
  const LEVELS = [1, 2, 3, 4, 5, 6];
  const W = 60;
  const blank = () => new Float32Array(W * W);
  const fill = (f: Float32Array, x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) f[y * W + x] = v;
  };

  it('takes off a line of a strong colour drawn on the map (a state boundary in red)', () => {
    const f = blank();
    fill(f, 2, 30, 57, 31, 5);
    removeMapDrawings(f, W, W, LEVELS);
    expect(f.some(v => v > 0)).toBe(false);
  });

  it('takes off a thick band of one strong colour with no rain around it (the continental shelf)', () => {
    const f = blank();
    fill(f, 5, 20, 50, 30, 4);
    removeMapDrawings(f, W, W, LEVELS);
    expect(f.some(v => v > 0)).toBe(false);
  });

  it('keeps a cell: its core and rings border rain, its weakest rim borders the map', () => {
    const f = blank();
    fill(f, 10, 10, 40, 40, 1);
    fill(f, 14, 14, 36, 36, 2);
    fill(f, 18, 18, 32, 32, 3);
    fill(f, 22, 22, 28, 28, 5);
    const before = f.slice();
    removeMapDrawings(f, W, W, LEVELS);
    expect(f).toEqual(before);
  });

  it('keeps light echoes of the weakest colours, however thin', () => {
    const f = blank();
    fill(f, 2, 30, 57, 31, 2);
    fill(f, 5, 5, 6, 6, 1);
    const before = f.slice();
    removeMapDrawings(f, W, W, LEVELS);
    expect(f).toEqual(before);
  });

  it('keeps a line of the map drawn through rain (it is bordered by rain)', () => {
    const f = blank();
    fill(f, 5, 5, 55, 55, 3);
    fill(f, 5, 30, 55, 31, 5);
    const before = f.slice();
    removeMapDrawings(f, W, W, LEVELS);
    expect(f).toEqual(before);
  });
});
