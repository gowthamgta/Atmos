import { describe, expect, it } from 'vitest';
import {
  CLOUD_TOP_STOPS,
  DEBLOCK_MAX_STEP,
  JPEG_BLOCK,
  LUMA_GRID_SIZE,
  buildLumaGrid,
  classifyCloudTop,
  cloudTopColor,
  cloudTopGradient,
  deblockJpeg,
  hrvBackground,
  irLumaToTempC,
  irTempToHeightKm,
  latFromMercatorY,
  mercatorHeight,
  mercatorRowMap,
  mercatorY,
  sampleLumaGrid,
  satelliteCoordinates,
  shadePixel,
  toOverlayPixels,
} from './satellite-image';

describe('mercator helpers', () => {
  it('inverts mercatorY', () => {
    for (const lat of [-30, 0, 4, 13, 22, 60]) expect(latFromMercatorY(mercatorY(lat))).toBeCloseTo(lat, 8);
  });

  it('gives a taller picture than plain latitude would for 5-37.5 N', () => {
    const h = mercatorHeight(1100);
    expect(h).toBeGreaterThan(1212); // the plain-latitude picture is about 1212 tall (32.5 of 29.5 degrees)
    expect(h).toBeLessThan(1360);
  });
});

describe('mercatorRowMap', () => {
  const rows = mercatorRowMap(900, 950);

  it('runs top to bottom through the source, in range', () => {
    expect(rows[0]).toBeGreaterThanOrEqual(0);
    expect(rows[0]).toBeLessThan(2);
    expect(rows.at(-1)!).toBeGreaterThan(897);
    expect(rows.at(-1)!).toBeLessThanOrEqual(899);
    for (let i = 1; i < rows.length; i++) expect(rows[i]).toBeGreaterThan(rows[i - 1] - 1e-6);
  });

  it('steps less through the source near the top (north), where a Mercator row covers fewer degrees', () => {
    const topStep = rows[11] - rows[10];
    const bottomStep = rows[rows.length - 1] - rows[rows.length - 2];
    expect(topStep).toBeLessThan(bottomStep);
  });
});

function shade(kind: 'hrv' | 'ir', r: number, g: number, b: number, bg = 58): number[] {
  const out = new Uint8ClampedArray(4);
  shadePixel(kind, r, g, b, bg, out, 0);
  return Array.from(out);
}

describe('shadePixel: the HRV picture by day', () => {
  it('keeps the picture as the service draws it, and only true black (the empty edge) is see-through', () => {
    expect(shade('hrv', 0, 0, 0)[3]).toBe(0);
    expect(shade('hrv', 123, 122, 60)).toEqual([123, 122, 60, 255]); // yellow land
    expect(shade('hrv', 247, 247, 204)).toEqual([247, 247, 204, 255]); // thick cloud
    expect(shade('hrv', 40, 41, 52)[3]).toBe(255); // dark sea is drawn, not cleared
  });

  it('draws the infrared where the HRV has no data (only the blue): warm ground clear, cloud see-through white', () => {
    expect(shade('hrv', 0, 0, 60)[3]).toBe(0); // warm ground in the no-data patch
    const [r, g, b, a] = shade('hrv', 0, 0, 200); // cold cloud in it
    expect(a).toBeGreaterThan(200);
    expect(Math.min(r, g, b)).toBeGreaterThan(220);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
    expect(b).toBeGreaterThanOrEqual(r);
  });

  it('makes that cloud more solid and brighter the colder it is, and never violet', () => {
    const faint = shade('hrv', 0, 0, 110);
    const solid = shade('hrv', 0, 0, 220);
    expect(solid[3]).toBeGreaterThan(faint[3]);
    expect(solid[0]).toBeGreaterThanOrEqual(faint[0]);
    for (const b of [60, 110, 160, 220, 255]) {
      const [r, g, bb, a] = shade('hrv', 0, 0, b);
      if (a > 0) expect(bb - r).toBeLessThan(20); // blue is never far above red: no violet patch
    }
  });

  it('measures the cloud against the typical land and sea, so the same blue shows more in dim morning light than at noon', () => {
    expect(shade('hrv', 0, 0, 100, 45)[3]).toBeGreaterThan(shade('hrv', 0, 0, 100, 95)[3]);
  });

  it('clears the violet line along the edge of the HRV data, but keeps a real lavender cloud as served', () => {
    // an antialiased edge pixel: bright red and green mixed with the violet of no data, far more blue than red
    const [r, , b, a] = shade('hrv', 45, 45, 130);
    expect(b - r).toBeLessThan(25);
    expect(a).toBeLessThan(255);
    expect(shade('hrv', 117, 114, 160)).toEqual([117, 114, 160, 255]); // thin lavender cloud: blue above red, but not by that much
    expect(shade('hrv', 150, 150, 70)).toEqual([150, 150, 70, 255]);
  });

  it('mixes the two where the HRV fades out, so the edge of its data has no seam', () => {
    // red and green around 4: between "no data" and a real, dark picture
    const edge = shade('hrv', 4, 5, 200);
    expect(edge[3]).toBeGreaterThan(150);
    const full = shade('hrv', 60, 60, 200);
    const none = shade('hrv', 0, 0, 200);
    expect(edge[0]).toBeGreaterThanOrEqual(Math.min(full[0], none[0]) - 1);
    expect(edge[0]).toBeLessThanOrEqual(Math.max(full[0], none[0]) + 1);
  });
});

describe('cloud tops: the infrared by night', () => {
  it('leaves the warm ground and sea see-through, and true black (no data) too', () => {
    expect(shade('ir', 25, 25, 25)[3]).toBe(0); // about +18 C: ground at night
    expect(shade('ir', 0, 0, 0)[3]).toBe(0);
  });

  it('shows middle cloud as a soft white-grey, so it still reads as cloud', () => {
    const [r, g, b, a] = shade('ir', 130, 130, 130); // about -29 C
    expect(a).toBeGreaterThan(150);
    expect(a).toBeLessThan(235);
    expect(Math.min(r, g, b)).toBeGreaterThan(200);
  });

  it('picks the high cold tops out in colour and solid', () => {
    const [r, g, b, a] = shade('ir', 232, 232, 232); // about -75 C
    expect(a).toBeGreaterThan(240);
    expect(r).toBeGreaterThan(220);
    expect(b).toBeLessThan(120); // orange or red, not grey
    const mid = shade('ir', 170, 170, 170); // about -50 C: cyan
    expect(mid[2]).toBeGreaterThan(mid[0]);
  });

  it('gets more opaque with every degree colder', () => {
    let last = -1;
    for (let luma = 0; luma <= 255; luma += 5) {
      const a = shade('ir', luma, luma, luma)[3];
      expect(a).toBeGreaterThanOrEqual(last);
      last = a;
    }
  });

  it('has a ramp that starts clear at the warm end and ends solid white at the coldest', () => {
    expect(cloudTopColor(30)[3]).toBe(0);
    expect(cloudTopColor(CLOUD_TOP_STOPS[0][0])[3]).toBe(0);
    expect(cloudTopColor(-85)).toEqual([255, 255, 255, 255]);
    expect(cloudTopColor(-120)).toEqual([255, 255, 255, 255]);
    // halfway between two stops is halfway in every channel
    const a = CLOUD_TOP_STOPS[3];
    const b = CLOUD_TOP_STOPS[4];
    const mid = cloudTopColor((a[0] + b[0]) / 2);
    expect(mid[3]).toBe(Math.round((a[4] + b[4]) / 2));
  });

  it('draws the colour bar from the same ramp: clear on the left, solid and white on the right', () => {
    const css = cloudTopGradient();
    expect(css.startsWith('linear-gradient(to right, rgba(')).toBe(true);
    expect(css).toMatch(/^linear-gradient\(to right, rgba\(\d+, \d+, \d+, 0\.1\d\) 0\.0%/); // +5 C: all but clear
    expect(css).toMatch(/rgba\(255, 255, 255, 1\.00\) 100\.0%\)$/);
  });
});

describe('hrvBackground', () => {
  it('is the median blue value, ignoring cloud and the empty corners', () => {
    const px = new Uint8ClampedArray(4 * 7 * 100);
    for (let i = 0; i < 100; i++) px.set([60, 60, i < 80 ? 60 : 230, 255], i * 28); // 20% cloud
    expect(hrvBackground(px)).toBe(60);
    const empty = new Uint8ClampedArray(4 * 7 * 20); // all black: nothing to measure
    expect(hrvBackground(empty)).toBe(60);
  });
});

describe('toOverlayPixels', () => {
  const width = 4;
  const srcHeight = 8;
  const src = new Uint8ClampedArray(width * srcHeight * 4);
  for (let y = 0; y < srcHeight; y++) for (let x = 0; x < width; x++) src.set([y * 30, 100, 50, 255], (y * width + x) * 4);

  it('returns a picture of the requested size with values taken from the source', () => {
    const out = toOverlayPixels(src, width, srcHeight, 'hrv', 10);
    expect(out.length).toBe(width * 10 * 4);
    for (let r = 0; r < 10; r++) {
      expect(out[r * width * 4]).toBeLessThanOrEqual(7 * 30);
      expect(out[r * width * 4 + 1]).toBe(100);
    }
  });

  it('blends between rows rather than copying, and keeps rows in order', () => {
    const out = toOverlayPixels(src, width, srcHeight, 'hrv', 20);
    let last = -1;
    for (let r = 0; r < 20; r++) {
      const v = out[r * width * 4];
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
    const distinct = new Set(Array.from({ length: 20 }, (_, r) => out[r * width * 4])).size;
    expect(distinct).toBeGreaterThan(8); // more than the 8 source rows: in-between values exist
  });

  it('makes black see-through', () => {
    const black = new Uint8ClampedArray(width * 2 * 4);
    for (let i = 0; i < black.length; i += 4) black[i + 3] = 255;
    const out = toOverlayPixels(black, width, 2, 'hrv', 3);
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(0);
  });

  it('draws an infrared picture in cloud-top colours', () => {
    const cold = new Uint8ClampedArray(width * 2 * 4);
    for (let i = 0; i < cold.length; i += 4) cold.set([232, 232, 232, 255], i);
    const out = toOverlayPixels(cold, width, 2, 'ir', 3);
    expect(out[3]).toBeGreaterThan(240);
    expect(out[2]).toBeLessThan(120);
  });
});

describe('satelliteCoordinates', () => {
  it('lists the corners clockwise from the north-west', () => {
    expect(satelliteCoordinates()).toEqual([[68, 37.5], [97.5, 37.5], [97.5, 5], [68, 5]]);
  });
});

describe('deblockJpeg', () => {
  /** A picture made of flat 8 x 8 blocks, each `step` brighter than the one to its left (the look of JPEG blocking). */
  function blocky(width: number, height: number, step: number): Uint8ClampedArray {
    const px = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = 60 + Math.floor(x / JPEG_BLOCK) * step;
        px.set([v, v, v, 255], (y * width + x) * 4);
      }
    }
    return px;
  }
  const row = (px: Uint8ClampedArray, w: number, y: number) => Array.from({ length: w }, (_, x) => px[(y * w + x) * 4]);

  it('softens a small step at a block edge into a ramp, without moving the flat parts far away', () => {
    const w = 32;
    const px = blocky(w, 16, 10);
    const before = row(px, w, 4);
    deblockJpeg(px, w, 16);
    const after = row(px, w, 4);
    // across the edge between pixel 7 and 8 the jump (10) is now spread over four pixels
    expect(Math.abs(after[8] - after[7])).toBeLessThan(Math.abs(before[8] - before[7]) * 0.4);
    for (let x = 6; x < 10; x++) expect(after[x + 1]).toBeGreaterThanOrEqual(after[x]); // still a monotonic ramp
    expect(after[3]).toBe(before[3]); // far from any edge nothing changes
  });

  it('leaves real edges (big steps) alone and never touches alpha', () => {
    const w = 32;
    const px = blocky(w, 16, DEBLOCK_MAX_STEP + 20);
    const copy = px.slice();
    deblockJpeg(px, w, 16);
    expect(px).toEqual(copy);
    const flat = blocky(w, 16, 6);
    flat.forEach((_, i) => { if (i % 4 === 3) flat[i] = 77; });
    deblockJpeg(flat, w, 16);
    for (let i = 3; i < flat.length; i += 4) expect(flat[i]).toBe(77);
  });

  it('also smooths horizontal block edges, and keeps flat pictures flat', () => {
    const w = 16;
    const px = new Uint8ClampedArray(w * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < w; x++) px.set([50 + Math.floor(y / 8) * 8, 0, 0, 255], (y * w + x) * 4);
    const col = (y: number) => px[(y * w + 3) * 4];
    const stepBefore = col(8) - col(7);
    deblockJpeg(px, w, 32);
    expect(col(8) - col(7)).toBeLessThan(stepBefore * 0.4);
    const flat = new Uint8ClampedArray(16 * 16 * 4).fill(120);
    deblockJpeg(flat, 16, 16);
    expect(new Set(flat).size).toBe(1);
  });
});

describe('infrared temperature, height and kind of cloud', () => {
  it('maps normalized luma 0..1 monotonically from warm (+30C) to cold (-85C)', () => {
    expect(irLumaToTempC(0)).toBeCloseTo(30, 1);
    expect(irLumaToTempC(1)).toBeCloseTo(-85, 1);
    expect(irLumaToTempC(0.8)).toBeLessThan(irLumaToTempC(0.4));
  });

  it('estimates higher cloud-top height for colder cloud-top temperatures', () => {
    expect(irTempToHeightKm(28)).toBe(0);
    expect(irTempToHeightKm(0)).toBeGreaterThan(3);
    expect(irTempToHeightKm(-65)).toBeGreaterThan(13);
    expect(irTempToHeightKm(-95)).toBeLessThanOrEqual(18);
  });

  it('classifies cloud regimes across warm surface, mid cloud, and overshooting tops', () => {
    expect(classifyCloudTop(20).label).toBe('Clear / Warm surface');
    expect(classifyCloudTop(5).label).toBe('Low cloud / Cumulus');
    expect(classifyCloudTop(-15).label).toBe('Mid-level cloud');
    expect(classifyCloudTop(-38).label).toBe('High cloud / Cirrus anvil');
    expect(classifyCloudTop(-58).label).toBe('Deep convection');
    expect(classifyCloudTop(-75).label).toBe('Overshooting top / Severe');
  });
});

describe('twilight terminator blending and luma hover grid', () => {
  it('blends daytime HRV with nighttime infrared across the dawn terminator', () => {
    const w = 16, h = 8;
    const hrv = new Uint8ClampedArray(w * h * 4);
    const ir = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      hrv.set([20, 20, 20, 255], i * 4); // a dim, real picture everywhere
      ir.set([220, 220, 220, 255], i * 4); // cold bright cloud everywhere
    }
    // 00:45 UTC on equinox: sun is rising in the east (97.5E ~ +11 deg) and still dark in the west (68E ~ -16 deg)
    const dawnMs = Date.parse('2026-03-21T00:45:00Z');
    const blended = toOverlayPixels(hrv, w, h, 'hrv', 8, ir, dawnMs);
    const west = Array.from(blended.slice((4 * w + 1) * 4, (4 * w + 1) * 4 + 4));
    const east = Array.from(blended.slice((4 * w + (w - 2)) * 4, (4 * w + (w - 2)) * 4 + 4));
    // West is in darkness: it shows the infrared's cloud-top colours (orange for this cold)
    expect(west[3]).toBeGreaterThan(200);
    expect(west[0]).toBeGreaterThan(200);
    expect(west[2]).toBeLessThan(120);
    // East is in daylight: it is the HRV picture, with at most a trace of the infrared where the sun is still low
    expect(east[3]).toBe(255);
    for (let c = 0; c < 3; c++) expect(Math.abs(east[c] - 20)).toBeLessThan(15);
  });

  it('builds and samples the compact luma grid accurately by lat/lon', () => {
    const w = 20, h = 20;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = x < 10 ? 40 : 210;
        src.set([v, v, v, 255], (y * w + x) * 4);
      }
    }
    const grid = buildLumaGrid(src, w, h, 'ir');
    const west = sampleLumaGrid(grid, LUMA_GRID_SIZE, 20, 72);
    const east = sampleLumaGrid(grid, LUMA_GRID_SIZE, 20, 92);
    expect(west).not.toBeNull();
    expect(east).not.toBeNull();
    expect(east!.tempC).toBeLessThan(west!.tempC - 40);
    expect(east!.heightKm).toBeGreaterThan(west!.heightKm + 5);
    expect(sampleLumaGrid(grid, LUMA_GRID_SIZE, 2, 72)).toBeNull(); // outside bounds
  });
});
