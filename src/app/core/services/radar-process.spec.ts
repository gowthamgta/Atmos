import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMD_RADAR_STATIONS, RadarProductKey } from '../domain/models/radar.model';
import { RADAR_FIELD_SIZE, decodeLastGifFrame, layoutMatches, processRadarPixels } from './radar-process';
import { RadarProcessor } from './radar-processor';
import { RadarService } from './radar.service';

/** FNV-1a of a field's bytes: the fields below were recorded from the implementation before it moved into a web worker. */
function hash(f: Float32Array): string {
  const u = new Uint32Array(f.buffer, f.byteOffset, f.length);
  let x = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) { x ^= u[i]; x = Math.imul(x, 0x01000193); }
  return (x >>> 0).toString(16);
}

// real IMD pictures (saved from mausam.imd.gov.in on 7 Oct 2026) and the hash of the field each must give
const CASES: [string, RadarProductKey, string, string][] = [
  ['karaikal', 'caz', 'karaikal-caz.gif', 'd8aed1c3'],
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
      const img = await svc.decodeImage(load(file));
      const res = svc.processRgba(station, product, config, true, img.rgba, img.w, img.h, null, true, false);
      expect(hash(res.fieldData.field)).toBe(expected);
    });
  }

  it('turns a picture that does not match the station layout into no field (the maintenance photo)', async () => {
    const processor = new RadarProcessor();
    const shr = IMD_RADAR_STATIONS.find(s => s.id === 'sriharikota')!;
    const config = shr.products.caz;
    // a Karaikal picture is far smaller than Sriharikota's configured crop
    const still = await processor.still(load('karaikal-caz.gif'), { crop: config.crop, palette: config.palette, isTransparent: true, isXBand: false });
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

