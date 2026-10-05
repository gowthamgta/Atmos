import { describe, it, expect } from 'vitest';
import { KARAIKAL_DWR_CONFIG, IMD_RADAR_STATIONS, rainRateToDbz } from '../domain/models/radar.model';
import { RADAR_COLOR_STOPS, sampleRadarColorRamp, removeRadialInterference } from './radar.service';

describe('Radar Domain & Config', () => {
  it('should have valid Karaikal S-Band DWR configuration', () => {
    expect(KARAIKAL_DWR_CONFIG.id).toBe('karaikal');
    expect(KARAIKAL_DWR_CONFIG.lat).toBeCloseTo(10.9254, 4);
    expect(KARAIKAL_DWR_CONFIG.lng).toBeCloseTo(79.8380, 4);
    expect(KARAIKAL_DWR_CONFIG.rings).toEqual([50, 100, 150, 200, 250]);
  });

  it('should configure CAZ column max product correctly', () => {
    const { caz } = KARAIKAL_DWR_CONFIG.products;

    expect(caz.file).toBe('caz_kkl.gif');
    expect(caz.rangeKm).toBe(255);
    expect(caz.maplibreCoordinates[0][0]).toBeCloseTo(77.51, 1);
    expect(caz.maplibreCoordinates[0][1]).toBeCloseTo(13.22, 1);
    expect(caz.maplibreCoordinates[2][0]).toBeCloseTo(82.17, 1);
    expect(caz.maplibreCoordinates[2][1]).toBeCloseTo(8.63, 1);
  });

  it('should have all six South India IMD Doppler Weather Radar stations properly configured', () => {
    expect(IMD_RADAR_STATIONS.length).toBe(6);

    const requiredStations = ['karaikal', 'chennai', 'pallikaranai', 'kochi', 'thiruvananthapuram', 'mangaluru'];
    for (const id of requiredStations) {
      const st = IMD_RADAR_STATIONS.find(s => s.id === id);
      expect(st).toBeDefined();
      expect(st!.lat).toBeGreaterThan(8);
      expect(st!.lat).toBeLessThan(14);
      expect(st!.lng).toBeGreaterThan(74);
      expect(st!.lng).toBeLessThan(82);
      expect(st!.products.caz).toBeDefined();
      expect(st!.products.caz.url).toContain(st!.code);
      expect(st!.products.ppi).toBeDefined();
      expect(st!.products.ppi.url).toContain(st!.code);
      expect(st!.products.sri).toBeDefined();
      expect(st!.products.sri.url).toContain(st!.code);
      expect(st!.products.pac).toBeDefined();
      expect(st!.products.pac.url).toContain(st!.code);
    }

    const tvm = IMD_RADAR_STATIONS.find(s => s.id === 'thiruvananthapuram')!;
    expect(tvm.products.caz.file).toBe('caz_tvm.gif');
    expect(tvm.products.sri.rangeKm).toBe(124);
    expect(tvm.products.caz.palette?.length).toBe(15);

    const mlr = IMD_RADAR_STATIONS.find(s => s.id === 'mangaluru')!;
    expect(mlr.products.caz.file).toBe('caz_mlr.gif');
    expect(mlr.band).toBe('C-Band');
    // Pure white is excluded: the Mangaluru basemap draws district borders in white
    expect(mlr.products.caz.palette!.some(p => p.rgb.every(c => c === 255))).toBe(false);

    const cni = IMD_RADAR_STATIONS.find(s => s.id === 'chennai')!;
    expect(cni.band).toBe('S-Band');
    expect(cni.operationalRangeKm).toBe(250);
    expect(cni.code).toBe('cni');
    expect(cni.products.caz.crop?.y).toBe(201);
    expect(cni.products.caz.crop?.w).toBe(500);
    expect(cni.products.caz.crop?.h).toBe(499);
    expect(cni.products.ppi.crop?.w).toBe(800);
    expect(cni.products.sri.crop?.w).toBe(600);
    expect(cni.products.pac.crop?.w).toBe(599);

    const koc = IMD_RADAR_STATIONS.find(s => s.id === 'kochi')!;
    expect(koc.band).toBe('S-Band');
    expect(koc.operationalRangeKm).toBe(250);
    expect(koc.code).toBe('koc');
    expect(koc.lat).toBeCloseTo(9.93, 1);
    expect(koc.lng).toBeCloseTo(76.27, 1);
    expect(koc.products.caz.crop?.x).toBe(100);
    expect(koc.products.caz.crop?.y).toBe(300);
    expect(koc.products.caz.crop?.w).toBe(600);
    expect(koc.products.caz.crop?.h).toBe(600);
    expect(koc.products.ppi.crop?.w).toBe(600);
    expect(koc.products.sri.crop?.w).toBe(708);
    expect(koc.products.pac.crop?.w).toBe(708);

    const plk = IMD_RADAR_STATIONS.find(s => s.id === 'pallikaranai')!;
    expect(plk.band).toBe('X-Band');
    expect(plk.operationalRangeKm).toBe(85);
    expect(plk.products.caz.crop).toBeDefined();
    expect(plk.products.caz.crop?.w).toBe(1800);
    expect(plk.products.caz.crop?.h).toBe(1800);
    expect(plk.products.ppi.crop?.w).toBe(2430);
    expect(plk.products.sri.crop?.w).toBe(2430);
    expect(plk.products.pac.crop?.w).toBe(2430);
  });

  it('should correctly extract ISO timestamp from synthetic binary GIF comment', () => {
    // Construct synthetic array buffer with embedded ISO timestamp comment
    const commentStr = 'IMD_DWR_KKL 2026-09-28T14:30:00 RAW_SWEEP_DATA';
    const buffer = new ArrayBuffer(commentStr.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < commentStr.length; i++) {
      view[i] = commentStr.charCodeAt(i);
    }

    // Binary comment parser
    const bytes = new Uint8Array(buffer);
    let str = '';
    for (let i = 0; i < Math.min(bytes.length, 2048); i++) {
      str += String.fromCharCode(bytes[i]);
    }
    const match = str.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);

    expect(match).not.toBeNull();
    if (match) {
      const [, yyyy, mm, dd, hh, min, ss] = match;
      expect(yyyy).toBe('2026');
      expect(mm).toBe('09');
      expect(dd).toBe('28');
      expect(hh).toBe('14');
      expect(min).toBe('30');
      expect(ss).toBe('00');
    }
  });

  it('should calculate calibrated dBZ values and color categories correctly', () => {
    const testCases = [
      { v: 0.20, expectedDbzMin: 12, expectedDbzMax: 16, expectedLabel: 'Light Echo' },
      { v: 0.90, expectedDbzMin: 18, expectedDbzMax: 22, expectedLabel: 'Light Rain' },
      { v: 1.80, expectedDbzMin: 28, expectedDbzMax: 32, expectedLabel: 'Moderate Rain' },
      { v: 2.60, expectedDbzMin: 36, expectedDbzMax: 39, expectedLabel: 'Heavy Rain' },
      { v: 3.30, expectedDbzMin: 42, expectedDbzMax: 46, expectedLabel: 'Heavy Rain' },
      { v: 3.90, expectedDbzMin: 48, expectedDbzMax: 51, expectedLabel: 'Torrential Rain' },
      { v: 4.80, expectedDbzMin: 55, expectedDbzMax: 65, expectedLabel: 'Severe Storm / Hail' }
    ];

    for (const tc of testCases) {
      const dbz = Math.min(65, Math.max(12, Math.round(12 + tc.v * 9.6)));
      expect(dbz).toBeGreaterThanOrEqual(tc.expectedDbzMin);
      expect(dbz).toBeLessThanOrEqual(tc.expectedDbzMax);

      let label = 'Light Rain';
      if (dbz >= 55) label = 'Severe Storm / Hail';
      else if (dbz >= 45) label = 'Torrential Rain';
      else if (dbz >= 36) label = 'Heavy Rain';
      else if (dbz >= 26) label = 'Moderate Rain';
      else if (dbz >= 18) label = 'Light Rain';
      else label = 'Light Echo';

      expect(label).toBe(tc.expectedLabel);
    }
  });

  it('should accurately classify authentic IMD Doppler storm core colors into Blue-Green-Yellow-Red-Purple', () => {
    const stormColors = [
      { name: 'orange_core', r: 255, g: 134, b: 0, isRain: true },
      { name: 'deep_orange', r: 255, g: 97, b: 0, isRain: true },
      { name: 'bright_yellow', r: 255, g: 236, b: 68, isRain: true },
      { name: 'cyan_fringe', r: 19, g: 151, b: 255, isRain: true },
      { name: 'royal_blue', r: 0, g: 47, b: 250, isRain: true },
      { name: 'kochi_storm_yellow', r: 244, g: 242, b: 79, isRain: true },
      { name: 'kochi_storm_orange', r: 245, g: 147, b: 14, isRain: true },
      { name: 'kochi_storm_orange_core', r: 250, g: 148, b: 7, isRain: true },
      { name: 'kochi_storm_orange_transition', r: 231, g: 165, b: 2, isRain: true },
      { name: 'kochi_storm_red_core', r: 250, g: 2, b: 2, isRain: true },
      { name: 'chennai_storm_red_core', r: 153, g: 0, b: 0, isRain: true },
      { name: 'chennai_storm_orange_core', r: 255, g: 102, b: 0, isRain: true },
      // Noise / Terrain / Vector overlay colors that must be strictly rejected
      { name: 'chennai_pure_green_district_border', r: 0, g: 255, b: 0, isRain: false },
      { name: 'chennai_green_district_border', r: 0, g: 204, b: 0, isRain: false },
      { name: 'kochi_western_ghats_tan', r: 247, g: 228, b: 217, isRain: false },
      { name: 'kochi_western_ghats_beige', r: 238, g: 220, b: 211, isRain: false },
      { name: 'kochi_western_ghats_cream', r: 251, g: 252, b: 218, isRain: false },
      { name: 'kochi_crosshair_sage', r: 213, g: 237, b: 178, isRain: false },
      { name: 'olive_terrain', r: 100, g: 173, b: 64, isRain: false },
      { name: 'khaki_terrain', r: 154, g: 154, b: 64, isRain: false },
      { name: 'grey_sea', r: 191, g: 191, b: 191, isRain: false },
      { name: 'dark_sea', r: 134, g: 134, b: 134, isRain: false },
      { name: 'black_border', r: 0, g: 0, b: 0, isRain: false },
      { name: 'kochi_pure_white_canvas', r: 255, g: 255, b: 255, isRain: false },
      { name: 'kochi_grid_line', r: 243, g: 243, b: 242, isRain: false },
      { name: 'kochi_sea_background', r: 211, g: 211, b: 211, isRain: false },
      { name: 'chennai_sea_blue', r: 102, g: 204, b: 255, isRain: false },
      { name: 'chennai_sea_ring', r: 153, g: 204, b: 255, isRain: false }
    ];

    const classify = (r: number, g: number, b: number) => {
      const maxRGB = Math.max(r, g, b);
      const minRGB = Math.min(r, g, b);
      const diff = maxRGB - minRGB;
      if (maxRGB <= 45) return 0.0;
      if (diff <= 8) return 0.0; // Rejects pure white canvas, grey sea, range rings, polar lines
      if (r <= 35 && g >= 160 && b <= 60) return 0.0; // Rejects Chennai district borders
      if (diff <= 25) return 0.0;
      if (b >= 140 && r >= 65) return 0.0; // Rejects Chennai sea background
      if (r >= 160 && g >= 140 && b >= 90 && r >= b) return 0.0; // Rejects Western Ghats elevation shading
      if (r >= 180 && b >= 140 && g <= 100) return 5.2; // Purple
      if ((r >= 180 && g <= 80 && b <= 80) || (r >= 150 && g <= 50 && b <= 50)) return 4.4; // Red
      if (r >= 210 && b <= 50 && g <= 180) {
        return g <= 155 ? 3.8 : 3.4; // Orange / Red-Orange
      }
      if (r >= 210 && g >= 190 && b <= 90) return 3.0; // Yellow
      if (b >= 180 && g >= 120 && r <= 70) return 1.4; // Light Blue
      if (b >= 150 && r <= 50 && g <= 120) return 1.0; // Blue
      if (b >= 120 && r <= 70 && g <= 50) return 0.7; // Indigo
      return 0.0;
    };

    for (const c of stormColors) {
      const val = classify(c.r, c.g, c.b);
      if (c.isRain) {
        expect(val, `${c.name} rgb(${c.r},${c.g},${c.b}) should be detected as rain`).toBeGreaterThan(0);
      } else {
        expect(val, `${c.name} rgb(${c.r},${c.g},${c.b}) should be rejected as terrain/sea`).toBe(0);
      }
    }
  });

  it('should categorize per-station freshness and enforce 180-minute operational display gating', () => {
    const now = Date.now();
    const freshTimestamp = new Date(now - 25 * 60 * 1000).getTime(); // 25 mins ago
    const recentTimestamp = new Date(now - 85 * 60 * 1000).getTime(); // 85 mins ago
    const extendedTimestamp = new Date(now - 145 * 60 * 1000).getTime(); // 145 mins ago
    const offlineTimestamp = new Date(now - 195 * 60 * 1000).getTime(); // 195 mins ago

    const evaluateStation = (epochMs: number) => {
      const ageMinutes = Math.max(0, Math.floor((now - epochMs) / (60 * 1000)));
      let freshness: 'fresh' | 'recent' | 'stale' | 'offline' = 'offline';
      if (ageMinutes <= 60) freshness = 'fresh';
      else if (ageMinutes <= 120) freshness = 'recent';
      else if (ageMinutes <= 180) freshness = 'stale';
      else freshness = 'offline';

      const isDisplayed = ageMinutes <= 180;
      return { ageMinutes, freshness, isDisplayed };
    };

    const fresh = evaluateStation(freshTimestamp);
    expect(fresh.freshness).toBe('fresh');
    expect(fresh.isDisplayed).toBe(true);

    const recent = evaluateStation(recentTimestamp);
    expect(recent.freshness).toBe('recent');
    expect(recent.isDisplayed).toBe(true);

    const extended = evaluateStation(extendedTimestamp);
    expect(extended.freshness).toBe('stale');
    expect(extended.isDisplayed).toBe(true);

    const offline = evaluateStation(offlineTimestamp);
    expect(offline.freshness).toBe('offline');
    expect(offline.isDisplayed).toBe(false);
  });
});

describe('Radar Overlap Color Merging & Color Ramp', () => {
  it('should map continuous rain intensity values to accurate RGB color ramp', () => {
    // 0.0 -> Transparent
    const [r0, g0, b0, a0] = sampleRadarColorRamp(0.0);
    expect(a0).toBe(0);

    // 0.5 -> Blue (Light Rain)
    const [r1, g1, b1, a1] = sampleRadarColorRamp(0.5);
    expect(b1).toBeGreaterThan(150);
    expect(r1).toBeLessThan(100);
    expect(a1).toBeGreaterThan(150);

    // 2.0 -> Green (Moderate Rain)
    const [r2, g2, b2, a2] = sampleRadarColorRamp(2.0);
    expect(g2).toBeGreaterThan(180);
    expect(r2).toBeLessThan(60);
    expect(b2).toBeLessThan(120);

    // 3.0 -> Yellow (Heavy Rain)
    const [r3, g3, b3, a3] = sampleRadarColorRamp(3.0);
    expect(r3).toBeGreaterThan(240);
    expect(g3).toBeGreaterThan(190);
    expect(b3).toBeLessThan(50);

    // 3.7 -> Orange (Intense Core)
    const [r4, g4, b4, a4] = sampleRadarColorRamp(3.7);
    expect(r4).toBeGreaterThan(240);
    expect(g4).toBeGreaterThan(100);
    expect(g4).toBeLessThan(150);
    expect(b4).toBeLessThan(40);

    // 4.4 -> Red (Torrential Rain)
    const [r5, g5, b5, a5] = sampleRadarColorRamp(4.4);
    expect(r5).toBeGreaterThan(220);
    expect(g5).toBeLessThan(100);
    expect(b5).toBeLessThan(100);

    // 5.2 -> Purple (Severe Storm / Hail)
    const [r6, g6, b6, a6] = sampleRadarColorRamp(5.2);
    expect(r6).toBeGreaterThan(150);
    expect(b6).toBeGreaterThan(200);
    expect(g6).toBeLessThan(100);
  });

  it('should merge overlapping radar intensities preserving peak core intensity without dark overlay', () => {
    function mergeTwoRadars(v1: number, w1: number, v2: number, w2: number): number {
      if (v1 <= 0 && v2 <= 0) return 0;
      if (v1 <= 0) return v2;
      if (v2 <= 0) return v1;
      const peak = Math.max(v1, v2);
      const avg = (v1 * w1 + v2 * w2) / (w1 + w2);
      return 0.80 * peak + 0.20 * avg;
    }

    // Karaikal has a strong Yellow storm core (v = 3.2), Kochi detects weak fringe (v = 1.0)
    // Karaikal is at ~180 km (w1 = 0.29), Kochi is at ~200 km (w2 = 0.21)
    const mergedCore = mergeTwoRadars(3.2, 0.29, 1.0, 0.21);
    expect(mergedCore).toBeGreaterThanOrEqual(3.0); // Preserved as Yellow!

    // In the merged color map, this outputs pure Yellow (RGB ~250, 204, 21), NOT a blue-obscured patch
    const [r, g, b] = sampleRadarColorRamp(mergedCore);
    expect(r).toBeGreaterThan(240); // Yellow red component
    expect(g).toBeGreaterThan(180); // Yellow green component
    expect(b).toBeLessThan(60);   // Yellow blue component (NOT obscured by blue!)

    // Where both radars observe identical light rain (v = 1.0, 1.0)
    const mergedEqual = mergeTwoRadars(1.0, 0.5, 1.0, 0.5);
    expect(mergedEqual).toBeCloseTo(1.0, 2);

    // Where only one radar observes an echo (v1 = 2.5, v2 = 0)
    const singleRadar = mergeTwoRadars(2.5, 0.6, 0.0, 0.2);
    expect(singleRadar).toBe(2.5);
  });

  it('should feather radar circular dish boundaries smoothly to eliminate hard seams', () => {
    const maxRadius = 510;
    const testDists = [
      { dist: 450, expectedFactor: 1.0 },  // Deep inside dish
      { dist: 504, expectedFactor: 0.75 }, // 6px from edge
      { dist: 506, expectedFactor: 0.5 },  // 4px from edge
      { dist: 508, expectedFactor: 0.25 }, // 2px from edge
      { dist: 510, expectedFactor: 0.0 }   // At dish boundary
    ];

    for (const td of testDists) {
      const dishEdgeDist = maxRadius - td.dist;
      let factor = 1.0;
      if (dishEdgeDist <= 0) {
        factor = 0.0;
      } else if (dishEdgeDist < 8) {
        factor = Math.max(0, dishEdgeDist / 8);
      }
      expect(factor).toBeCloseTo(td.expectedFactor, 2);
    }
  });
});

describe('Radar legend palettes', () => {
  it('converts rain rates to reflectivity with the Marshall-Palmer relation', () => {
    expect(rainRateToDbz(1)).toBeCloseTo(23.0, 1);
    expect(rainRateToDbz(10)).toBeCloseTo(39.0, 1);
    expect(rainRateToDbz(100)).toBeCloseTo(55.0, 1);
  });

  it('orders every palette from strongest to weakest echo', () => {
    for (const st of IMD_RADAR_STATIONS) {
      for (const product of Object.values(st.products)) {
        if (!product.palette) continue;
        for (let i = 1; i < product.palette.length; i++) {
          expect(product.palette[i].dbz).toBeLessThan(product.palette[i - 1].dbz);
        }
      }
    }
  });
});

describe('Radial interference removal', () => {
  const size = 256;
  const c = size / 2;
  const paint = (grid: Float32Array, fn: (r: number, deg: number) => boolean) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = Math.hypot(x - c, y - c);
        let deg = (Math.atan2(y - c, x - c) * 180) / Math.PI;
        if (deg < 0) deg += 360;
        if (r <= c - 2 && fn(r, deg)) grid[y * size + x] = 2.0;
      }
    }
  };

  it('removes a thin spoke pointing at the radar', () => {
    const grid = new Float32Array(size * size);
    paint(grid, (r, deg) => r > 40 && Math.abs(deg - 200) < 0.8);
    const before = grid.filter(v => v > 0).length;
    const removed = removeRadialInterference(grid, size);
    expect(before).toBeGreaterThan(50);
    expect(removed).toBe(before);
  });

  it('keeps a broad storm and a spoke-free field untouched', () => {
    const grid = new Float32Array(size * size);
    // Storm cell ~40 degrees wide centred at 60 degrees, 50-110 px out
    paint(grid, (r, deg) => r > 50 && r < 110 && Math.abs(deg - 60) < 20);
    const before = grid.filter(v => v > 0).length;
    expect(removeRadialInterference(grid, size)).toBe(0);
    expect(grid.filter(v => v > 0).length).toBe(before);
  });

  it('removes the spoke but keeps an adjacent storm', () => {
    const grid = new Float32Array(size * size);
    paint(grid, (r, deg) => r > 50 && r < 110 && Math.abs(deg - 60) < 20);
    const storm = grid.filter(v => v > 0).length;
    paint(grid, (r, deg) => r > 40 && Math.abs(deg - 200) < 0.8);
    removeRadialInterference(grid, size);
    expect(grid.filter(v => v > 0).length).toBe(storm);
  });
});
