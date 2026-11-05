import { describe, expect, it } from 'vitest';
import {
  CLOUD_TOP_STOPS,
  classifyCloudTop,
  cloudTopColor,
  cloudTopGradient,
  hrvBackground,
  irLumaToTempC,
  irTempToHeightKm,
  latFromMercatorY,
  mercatorHeight,
  mercatorRowMap,
  mercatorY,
  shadePixel,
  hrvCloudKeep,
  windyCloudColor,
  toOverlayPixels,
} from './satellite-image';

describe('mercator helpers', () => {
  it('inverts mercatorY', () => {
    for (const lat of [-30, 0, 4, 13, 22, 60]) expect(latFromMercatorY(mercatorY(lat))).toBeCloseTo(lat, 8);
  });

  it('gives a taller picture than plain latitude would for 5-20 N', () => {
    const h = mercatorHeight(1100);
    expect(h).toBeGreaterThan(600); // the plain-latitude picture is 600 tall (15 of 27.5 degrees)
    expect(h).toBeLessThan(630);
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
  it("draws the picture in Windy's palette, and only true black (the empty edge) is see-through", () => {
    expect(shade('hrv', 0, 0, 0)[3]).toBe(0);
    const [lr, , lb, la] = shade('hrv', 123, 122, 60); // yellow land / low sunlit cloud: sand, warmer than blue
    expect(la).toBe(255);
    expect(lr).toBeGreaterThan(lb + 15);
    const [cr, cg, cb, ca] = shade('hrv', 247, 247, 204); // thick cloud: light
    expect(ca).toBe(255);
    expect(Math.min(cr, cg, cb)).toBeGreaterThan(160);
    expect(shade('hrv', 40, 41, 52)[3]).toBe(255); // dark sea is drawn, not cleared
  });

  it('tells high cloud from low: cold tops white with a blue tint, warm ones sand', () => {
    const background = 60;
    const high = windyCloudColor(215, 215, 240, background);
    const low = windyCloudColor(190, 170, 80, background);
    expect(high[2]).toBeGreaterThan(high[0]);
    expect(Math.min(...high)).toBeGreaterThan(130);
    expect(Math.min(...windyCloudColor(252, 252, 255, background))).toBeGreaterThan(170); // only the brightest cores go white
    expect(low[0]).toBeGreaterThan(low[2] + 15);
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
    const lavender = shade('hrv', 117, 114, 160); // thin lavender cloud: blue above red, but not by that much
    expect(lavender[3]).toBe(255);
    expect(lavender[2]).toBeGreaterThan(lavender[0]);
    const sand = shade('hrv', 150, 150, 70);
    expect(sand[3]).toBe(255);
    expect(sand[0]).toBeGreaterThan(sand[2]);
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

  it('returns a picture of the requested size with values taken from the source', () => {
    const out = toOverlayPixels(src, width, srcHeight, 'hrv', 10);
    expect(out.length).toBe(width * 10 * 4);
    for (let r = 0; r < 10; r++) {
      expect(out[r * width * 4]).toBeLessThanOrEqual(255);
      expect(out[r * width * 4 + 3]).toBeGreaterThan(0);
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

describe('twilight terminator blending and the clearing of the ground', () => {
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

  it('takes out the clear ground of an HRV picture and keeps every cloud pixel with its own colour', () => {
    const w = 600, h = 400; // about 5 km a pixel, so the ground window (65 km) is wider than the clouds
    const src = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const lowCloud = x >= 80 && x < 100 && y >= 80 && y < 100; // sunlit, yellowish, not cold
        const highCloud = x >= 360 && x < 400 && y >= 140 && y < 190; // white and lavender
        const rgb = lowCloud ? [150, 140, 90] : highCloud ? [215, 215, 240] : [95, 85, 40]; // yellow land
        src.set([...rgb, 255], (y * w + x) * 4);
      }
    }
    const keep = hrvCloudKeep(src, w, h);
    expect(keep[300 * w + 250]).toBeLessThan(0.05); // plain ground
    expect(keep[90 * w + 90]).toBeGreaterThan(0.9); // low cloud stays
    expect(keep[160 * w + 380]).toBeGreaterThan(0.9); // high cloud stays
    const out = toOverlayPixels(src, w, h, 'hrv', h);
    const o = (160 * w + 380) * 4;
    expect(out[o + 3]).toBe(255);
    expect(out[o + 2]).toBeGreaterThanOrEqual(out[o]); // high cloud stays white with a blue tint
    expect(out[(300 * w + 250) * 4 + 3]).toBeLessThan(15);
  });
});
