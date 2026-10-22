import { describe, expect, it } from 'vitest';
import { IMD_RADAR_STATIONS, ProcessedRadarResult } from '../domain/models/radar.model';
import { RadarCompute, composeWithAloft, replyTransfer, runJob } from './radar-compute';
import { composeRadarMosaic } from './radar-mosaic';
import { nowcastPicture } from './radar-nowcast';
import { uniformMotionField } from './radar-motion';

const N = 120;
const karaikal = IMD_RADAR_STATIONS.find(s => s.id === 'karaikal')!;

function scan(value: number): ProcessedRadarResult {
  const config = karaikal.products.caz;
  return {
    stationId: 'karaikal',
    dataUrl: '',
    fieldData: { field: new Float32Array(N * N).fill(value), cropW: N, cropH: N, cx: N / 2, cy: N / 2, radius: N / 2, bounds: config.bounds },
    timing: { ist: '', utc: '', date: '', epochMs: Date.UTC(2026, 9, 22, 6) },
    coordinates: config.maplibreCoordinates,
    isDisplayed: true,
  };
}

describe('radar work off the main thread', () => {
  it('composes the same mosaic as before, with rain aloft see-through', () => {
    const faint = scan(0.8); // about 20 dBZ everywhere: see-through far from Karaikal, solid near it
    const req = { sources: [['karaikal', faint] as [string, ProcessedRadarResult]], kmPerPx: 2, maxPx: 600, product: 'caz' as const };
    const plain = composeRadarMosaic(IMD_RADAR_STATIONS, req.sources, 2, 600, 'caz')!;
    const withFade = composeWithAloft(req)!;
    expect(withFade.displayField).toEqual(plain.displayField); // the intensity is never changed
    expect(withFade.displayFade).toBeDefined();
    const fade = withFade.displayFade!;
    expect(fade.reduce((a, b) => Math.min(a, b), 255)).toBeLessThan(255); // the far edge is faded
    expect(fade.reduce((a, b) => Math.max(a, b), 0)).toBe(255); // the middle (near the radar) is not
  });

  it('runs a job and names the buffers it can hand back without copying', () => {
    const reply = runJob({ id: 7, kind: 'compose', req: { sources: [['karaikal', scan(3)]], kmPerPx: 2, maxPx: 600, product: 'caz' } });
    expect(reply.id).toBe(7);
    expect(reply.mosaic?.fieldData.cropW).toBeGreaterThan(0);
    expect(replyTransfer(reply).length).toBeGreaterThanOrEqual(2);
    expect(runJob({ id: 8, kind: 'compose', req: { sources: [], kmPerPx: 2, maxPx: 600, product: 'caz' } }).mosaic).toBeNull();
  });

  it('makes the nowcast pictures of every lead at once, as nowcastPicture does', () => {
    const field = new Uint8Array(40 * 40);
    field[20 * 40 + 20] = 200;
    const box = { west: 79, east: 80, north: 11, south: 10, width: 40, height: 40 };
    const motion = uniformMotionField({ west: 79, east: 80, north: 11, south: 10 }, 0.2, 0);
    const reply = runJob({ id: 1, kind: 'nowcast', req: { field, box, motion, leads: [10, 30], outScale: 2 } });
    expect(reply.pictures!.map(p => p.lead)).toEqual([10, 30]);
    expect(reply.pictures![1].field).toEqual(nowcastPicture(field, box, motion, 30, 2).field);
  });

  it('works on the main thread where there are no workers (the same results)', async () => {
    const compute = new RadarCompute();
    const req = { sources: [['karaikal', scan(3)] as [string, ProcessedRadarResult]], kmPerPx: 2, maxPx: 600, product: 'caz' as const };
    const viaClient = await compute.compose(req);
    expect(viaClient!.displayField).toEqual(composeWithAloft(req)!.displayField);
  });
});
