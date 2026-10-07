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
  ['chennai', 'caz', 'chennai-caz.gif', '924f1322'],
  ['karaikal', 'caz', 'karaikal-caz.gif', 'ccc5dfd8'],
  ['thiruvananthapuram', 'ppz', 'thiruvananthapuram-ppz.gif', '44e2091b'],
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
      const svc = new RadarService() as any;
      const img = await svc.decodeImage(load(file));
      const res = svc.processRgba(station, product, config, true, img.rgba, img.w, img.h, null, true, false);
      expect(hash(res.fieldData.field)).toBe(expected);
    });
  }

  it('turns a picture that does not match the station layout into no field (the maintenance photo)', async () => {
    const processor = new RadarProcessor();
    const kochi = IMD_RADAR_STATIONS.find(s => s.id === 'kochi')!;
    const config = kochi.products.caz;
    // a Chennai picture is far smaller than Kochi's configured crop
    const still = await processor.still(load('chennai-caz.gif'), { crop: config.crop, palette: config.palette, isTransparent: true, isXBand: false });
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
