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
  hrvCloudKeep,
  windyVisibleColor,
  groundTone,
  hrvCloudLayers,
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

describe("shadePixel: the HRV picture by day, as Windy's visible satellite", () => {
  it('draws the whole picture opaque, ground included; only true black (the empty edge) is see-through', () => {
    expect(shade('hrv', 0, 0, 0)[3]).toBe(0);
    expect(shade('hrv', 123, 122, 60)[3]).toBe(255); // yellow land
    expect(shade('hrv', 40, 41, 52)[3]).toBe(255);   // dark sea
    expect(shade('hrv', 247, 247, 204)[3]).toBe(255); // thick cloud
  });

  it('draws the infrared where the HRV has no data (only the blue): the warm ground dark, cold cloud bright, never violet', () => {
    const ground = shade('hrv', 0, 0, 60);
    const cloud = shade('hrv', 0, 0, 220);
    expect(ground[3]).toBe(255);
    expect(cloud[3]).toBe(255);
    expect(cloud[0]).toBeGreaterThan(ground[0] + 100);
    for (const b of [60, 110, 160, 220, 255]) {
      const [r, , bb] = shade('hrv', 0, 0, b);
      expect(bb - r).toBeLessThan(30); // the cool ramp: a little blue, never the violet patch
    }
  });

  it('clears the violet line along the edge of the HRV data', () => {
    const [r, , b] = shade('hrv', 45, 45, 130); // bright red and green mixed with the violet of no data
    expect(b - r).toBeLessThan(30);
  });

  it('mixes the two where the HRV fades out, so the edge of its data has no seam', () => {
    const edge = shade('hrv', 4, 5, 200);
    const full = shade('hrv', 60, 60, 200);
    const none = shade('hrv', 0, 0, 200);
    expect(edge[3]).toBeGreaterThan(150);
    expect(edge[0]).toBeGreaterThanOrEqual(Math.min(full[0], none[0]) - 1);
    expect(edge[0]).toBeLessThanOrEqual(Math.max(full[0], none[0]) + 1);
  });
});

describe("Windy's colours for the visible picture", () => {
  const background = 60; // the blue of clear ground (the infrared of a warm surface)
  const land = 120;      // the HRV brightness of clear land around the pixel

  it('draws clear ground as Windy does: land a dark neutral slate, the sea navy', () => {
    const [r, g, b] = windyVisibleColor(land, land, 60, background, land);
    expect((r + g + b) / 3).toBeGreaterThan(55);
    expect((r + g + b) / 3).toBeLessThan(85);
    expect(Math.abs(r - b)).toBeLessThan(15); // slate, not the yellow of the HRV's land
    const sea = windyVisibleColor(34, 34, 60, background, 34);
    expect(sea[2]).toBeGreaterThan(sea[0] + 15); // navy
    expect((sea[0] + sea[1] + sea[2]) / 3).toBeLessThan((r + g + b) / 3);
    expect(groundTone(40)).toBeLessThan(groundTone(land));
  });

  it('draws low, warm cloud gold and cold high cloud blue-white', () => {
    const low = windyVisibleColor(200, 200, 90, background, land);
    const high = windyVisibleColor(200, 200, 250, background, land);
    expect(low[0]).toBeGreaterThan(low[2] + 50);  // amber: much more red than blue
    expect(high[2]).toBeGreaterThan(high[0]);     // blue-white
    expect(Math.min(...high)).toBeGreaterThan(180);
  });

  it('gets brighter the more the cloud stands above the ground, up to white', () => {
    const tones = [130, 160, 190, 230].map(l => windyVisibleColor(l, l, 250, background, land));
    for (let i = 1; i < tones.length; i++) expect(tones[i][0]).toBeGreaterThan(tones[i - 1][0]);
    expect(Math.min(...windyVisibleColor(255, 255, 255, background, land))).toBeGreaterThan(235);
  });

  it('draws clear land flat, whatever its own variation and noise (no mottle), as Windy does', () => {
    const colours = [land - 20, land - 8, land, land + 5, land + 8].map(l => windyVisibleColor(l, l, 55, background, land));
    for (const c of colours) for (let k = 0; k < 3; k++) expect(Math.abs(c[k] - colours[2][k])).toBeLessThan(1);
  });

  it('turns gold only where there is cloud: the ground stays slate however warm', () => {
    const ground = windyVisibleColor(land, land, 55, background, land);
    expect(ground[0] - ground[2]).toBeLessThan(12); // the slight warmth of Windy's clear land, not gold (gold is 40 and more)
  });
});

describe("cloud tops: the infrared in Windy's style (grey, with colour on the cold tops)", () => {
  it('draws warm ground and sea dark grey and solid, and leaves true black (no data) see-through', () => {
    const [r, g, bl, a2] = shade('ir', 8, 8, 8); // about +29 C: the sea
    expect(a2).toBeGreaterThan(200);
    expect(Math.max(r, g, bl)).toBeLessThan(120);
    expect(shade('ir', 0, 0, 0)[3]).toBe(0);
  });

  it('gets lighter grey for colder cloud, up to about -32 C', () => {
    const low = shade('ir', 44, 44, 44); // about +10 C
    const mid = shade('ir', 100, 100, 100); // about -10 C
    const high = shade('ir', 140, 140, 140); // about -31 C
    expect(mid[0]).toBeGreaterThan(low[0] + 30);
    expect(high[0]).toBeGreaterThan(mid[0] + 20);
    expect(Math.abs(high[0] - high[2])).toBeLessThan(25); // still grey
  });

  it('picks the height of the cold tops out in colour: blue, cyan, green, yellow, orange, red, and dark red at the coldest', () => {
    const teal = shade('ir', 192, 192, 192); // about -56 C: cyan
    expect(teal[1]).toBeGreaterThan(teal[0]);
    const orange = shade('ir', 241, 241, 241); // about -79 C: orange
    expect(orange[0]).toBeGreaterThan(170);
    expect(orange[2]).toBeLessThan(130);
    const red = shade('ir', 248, 248, 248); // about -82 C: red
    expect(red[0]).toBeGreaterThan(red[1] + 50);
    const [dr, dg, db] = cloudTopColor(-85); // the coldest core: deep red
    expect(dr).toBeGreaterThan(80);
    expect(dr).toBeLessThan(140);
    expect(dg).toBeLessThan(40);
    expect(db).toBeLessThan(50);
  });

  it('is solid wherever there is any cloud colour', () => {
    for (const t of [-40, -55, -70, -80]) expect(cloudTopColor(t)[3]).toBeGreaterThan(250);
  });

  it('has a ramp that is mid grey and solid at the warm end and deep red at the coldest', () => {
    expect(cloudTopColor(30)[3]).toBeGreaterThan(200);
    expect(cloudTopColor(CLOUD_TOP_STOPS[0][0])[0]).toBeLessThan(120); // dark grey, not black
    expect(cloudTopColor(-120)).toEqual([100, 6, 12, 255]);
    const a = CLOUD_TOP_STOPS[3];
    const b = CLOUD_TOP_STOPS[4];
    const mid = cloudTopColor((a[0] + b[0]) / 2);
    expect(mid[3]).toBe(Math.round((a[4] + b[4]) / 2));
  });

  it('draws the colour bar from the same ramp, grey on the left to deep red on the right', () => {
    const css = cloudTopGradient();
    expect(css.startsWith('linear-gradient(to right, rgba(')).toBe(true);
    expect(css).toMatch(/^linear-gradient\(to right, rgba\(\d+, \d+, \d+, 0\.9\d\) 0\.0%/);
    expect(css).toMatch(/rgba\(\d+, \d+, \d+, 1\.00\) 100\.0%\)$/);
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

  it('returns a picture of the requested size with values taken from the source, opaque, the bright end lighter than the dark end', () => {
    const out = toOverlayPixels(src, width, srcHeight, 'hrv', 10);
    expect(out.length).toBe(width * 10 * 4);
    for (let r = 1; r < 10; r++) expect(out[r * width * 4 + 3]).toBe(255);
    expect(out[9 * width * 4]).toBeGreaterThan(out[1 * width * 4]);
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
      hrv.set(i % w >= w - 3 ? [200, 200, 230, 255] : [20, 20, 20, 255], i * 4); // dim ground, with cloud in the far east
      ir.set([220, 220, 220, 255], i * 4); // cold bright cloud everywhere
    }
    // 00:45 UTC on equinox: sun is rising in the east (97.5E ~ +11 deg) and still dark in the west (68E ~ -16 deg)
    const dawnMs = Date.parse('2026-03-21T00:45:00Z');
    const blended = toOverlayPixels(hrv, w, h, 'hrv', 8, ir, dawnMs);
    const west = Array.from(blended.slice((4 * w + 1) * 4, (4 * w + 1) * 4 + 4));
    const east = Array.from(blended.slice((4 * w + (w - 2)) * 4, (4 * w + (w - 2)) * 4 + 4));
    // West is in darkness: it shows the infrared's cloud-top colours (orange for this cold)
    expect(west[3]).toBeGreaterThan(200);
    expect(west[0]).toBeGreaterThan(150);
    expect(west[2]).toBeLessThan(120);
    // East is in daylight: it is the HRV picture, with at most a trace of the infrared where the sun is still low
    expect(east[3]).toBeGreaterThan(200);
    expect(east[2]).toBeGreaterThan(east[0]); // high cloud: white with a blue tint
    expect(east[0]).toBeGreaterThan(130);
  });

  it('measures the ground of an HRV picture: the clear ground dark slate, low cloud gold and high cloud blue-white over it', () => {
    const w = 600, h = 400; // about 5 km a pixel, so the ground window (65 km) is wider than the clouds
    const src = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const lowCloud = x >= 80 && x < 100 && y >= 80 && y < 100; // sunlit, yellowish, not cold
        const highCloud = x >= 360 && x < 400 && y >= 140 && y < 190; // white and lavender
        const rgb = lowCloud ? [205, 195, 90] : highCloud ? [215, 215, 240] : [95, 85, 40]; // yellow land
        src.set([...rgb, 255], (y * w + x) * 4);
      }
    }
    const keep = hrvCloudKeep(src, w, h);
    expect(keep[300 * w + 250]).toBeLessThan(0.05); // plain ground
    expect(keep[90 * w + 90]).toBeGreaterThan(0.9); // low cloud
    expect(keep[160 * w + 380]).toBeGreaterThan(0.9); // high cloud
    const out = toOverlayPixels(src, w, h, 'hrv', h);
    const at = (x: number, y: number) => Array.from(out.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
    const [gr, gg, gb, ga] = at(250, 300);
    expect(ga).toBe(255);
    expect((gr + gg + gb) / 3).toBeLessThan(80); // the ground dark
    const [lr, , lb] = at(90, 90);
    expect(lr).toBeGreaterThan(lb + 25); // low cloud gold (bright, so towards Windy's cream)
    const [hr, , hb] = at(380, 160);
    expect(hb).toBeGreaterThan(hr); // high cloud blue-white
    expect(hr).toBeGreaterThan(170);
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

describe('the ground of the visible picture', () => {
  it('gives the clear-ground brightness with the cloud mask, the same size as the picture', () => {
    const w = 64;
    const h = 64;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const cloud = i % w > 40;
      px.set([cloud ? 230 : 80, cloud ? 230 : 80, cloud ? 200 : 60, 255], i * 4);
    }
    const { keep, ground: plane } = hrvCloudLayers(px, w, h);
    expect(plane.length).toBe(w * h);
    expect(plane[20 * w + 10]).toBeGreaterThan(70);
    expect(plane[20 * w + 10]).toBeLessThan(95); // clear ground reads as the ground
    expect(keep[20 * w + 60]).toBeGreaterThan(0.9);
  });
});
