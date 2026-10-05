import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadBakedTerrain } from '../../../testing/baked-terrain';
import {
  REGIONAL_500M_BOUNDS,
  REGIONAL_500M_CENTER,
  REGIONAL_500M_COORDINATES,
  REGIONAL_GRID_WIDTH,
  REGIONAL_GRID_HEIGHT,
  REGIONAL_HEATMAP_WIDTH,
  REGIONAL_HEATMAP_HEIGHT,
  ECMWF_NODE_GRID,
  TAMIL_NADU_CITIES,
  TAMIL_NADU_LANDMARKS,
  mercatorY,
  latFromMercatorY,
  rasterRowLatitude,
  rasterColumnLongitude,
  nearestCity,
  describeTerrain,
  setTerrainRaster,
  getRegionalElevation,
  TERRAIN_FALLBACK_METERS,
  degToCompass,
  TEMP_PALETTE_HEX,
  TEMP_PALETTE_RGB,
  HUMIDITY_PALETTE_HEX,
  HUMIDITY_PALETTE_RGB,
  RAIN_PALETTE_HEX,
  RAIN_PALETTE_RGB,
  CAPE_PALETTE_HEX,
  CAPE_PALETTE_RGB,
  SOUTH_INDIA_CITIES,
  getRainRiskLabel,
  getCapeRiskLabel,
  ELEVATION_PRESETS,
  interpolateAtmosphericSounding
} from '../domain/models/microclimate.model';
import {
  downscaleTemperature,
  downscaleHumidity,
  downscaleRain,
  downscaleCape,
  orographicFraction,
  windSpeedup
} from '../domain/math/microclimate-grid';

describe('Tamil Nadu Regional Microclimate Domain', () => {
  it('should cover the whole state', () => {
    expect(REGIONAL_500M_BOUNDS).toEqual({ minLat: 8.0, maxLat: 13.6, minLon: 76.2, maxLon: 80.4 });

    // Tamil Nadu spans roughly 8.07-13.57 N, 76.23-80.35 E: it must sit inside the domain
    expect(REGIONAL_500M_BOUNDS.minLat).toBeLessThan(8.07);
    expect(REGIONAL_500M_BOUNDS.maxLat).toBeGreaterThan(13.57);
    expect(REGIONAL_500M_BOUNDS.minLon).toBeLessThan(76.23);
    expect(REGIONAL_500M_BOUNDS.maxLon).toBeGreaterThan(80.35);

    expect(REGIONAL_500M_CENTER.lat).toBeGreaterThan(REGIONAL_500M_BOUNDS.minLat);
    expect(REGIONAL_500M_CENTER.lat).toBeLessThan(REGIONAL_500M_BOUNDS.maxLat);

    // Image corners [NW, NE, SE, SW] are the OUTER cell edges: half a cell beyond the bounds
    expect(REGIONAL_500M_COORDINATES).toHaveLength(4);
    const [nw, ne, se, sw] = REGIONAL_500M_COORDINATES;
    const halfCellLon = 4.2 / 840 / 2;
    expect(nw[0]).toBeCloseTo(76.2 - halfCellLon, 9);
    expect(ne[0]).toBeCloseTo(80.4 + halfCellLon, 9);
    expect(se[0]).toBeCloseTo(80.4 + halfCellLon, 9);
    expect(sw[0]).toBeCloseTo(76.2 - halfCellLon, 9);
    // North/south extend by half a Mercator row: slightly beyond 13.6 / 8.0, but by well under a row
    expect(nw[1]).toBeGreaterThan(13.6);
    expect(nw[1]).toBeLessThan(13.6 + 0.005);
    expect(ne[1]).toBe(nw[1]);
    expect(sw[1]).toBeLessThan(8.0);
    expect(sw[1]).toBeGreaterThan(8.0 - 0.005);
    expect(se[1]).toBe(sw[1]);
  });

  it('should render at ~500-meter ground resolution over the whole state', () => {
    expect(REGIONAL_GRID_WIDTH).toBe(841);
    expect(REGIONAL_GRID_HEIGHT).toBe(1121);
    expect(REGIONAL_HEATMAP_WIDTH).toBe(REGIONAL_GRID_WIDTH);
    expect(REGIONAL_HEATMAP_HEIGHT).toBe(REGIONAL_GRID_HEIGHT);

    const b = REGIONAL_500M_BOUNDS;
    const midLat = (b.minLat + b.maxLat) / 2;
    const cellEastWestM = ((b.maxLon - b.minLon) * 111320 * Math.cos((midLat * Math.PI) / 180)) / (REGIONAL_GRID_WIDTH - 1);
    const cellNorthSouthM = ((b.maxLat - b.minLat) * 111320) / (REGIONAL_GRID_HEIGHT - 1);
    expect(cellEastWestM).toBeGreaterThan(500);
    expect(cellEastWestM).toBeLessThan(600);
    expect(cellNorthSouthM).toBeGreaterThan(500);
    expect(cellNorthSouthM).toBeLessThan(600);
  });

  it('should space raster rows evenly in Web-Mercator Y so the image drapes exactly on the map', () => {
    const b = REGIONAL_500M_BOUNDS;
    expect(rasterRowLatitude(0)).toBeCloseTo(b.maxLat, 9);
    expect(rasterRowLatitude(REGIONAL_GRID_HEIGHT - 1)).toBeCloseTo(b.minLat, 9);
    expect(rasterColumnLongitude(0)).toBeCloseTo(b.minLon, 9);
    expect(rasterColumnLongitude(REGIONAL_GRID_WIDTH - 1)).toBeCloseTo(b.maxLon, 9);

    // Even Mercator spacing: the middle row is NOT the linear-latitude midpoint
    const middle = rasterRowLatitude((REGIONAL_GRID_HEIGHT - 1) / 2);
    const linearMiddle = (b.minLat + b.maxLat) / 2;
    expect(Math.abs(middle - linearMiddle)).toBeGreaterThan(0.005);
    expect(middle).toBeCloseTo(latFromMercatorY((mercatorY(b.minLat) + mercatorY(b.maxLat)) / 2), 9);

    // Strictly decreasing northwards -> southwards, with equal Mercator steps
    const step0 = mercatorY(rasterRowLatitude(0)) - mercatorY(rasterRowLatitude(1));
    const stepN = mercatorY(rasterRowLatitude(500)) - mercatorY(rasterRowLatitude(501));
    expect(step0).toBeGreaterThan(0);
    expect(stepN).toBeCloseTo(step0, 10);
  });

  it('should round-trip latitudes through Web-Mercator', () => {
    for (const lat of [8.0, 10.8, 13.6, -33.3]) {
      expect(latFromMercatorY(mercatorY(lat))).toBeCloseTo(lat, 9);
    }
  });

  it('should lay the ECMWF node grid over the raster with a margin', () => {
    const g = ECMWF_NODE_GRID;
    const b = REGIONAL_500M_BOUNDS;
    expect(g.nLat * g.nLon).toBe(130);
    expect(g.minLat).toBeLessThanOrEqual(b.minLat);
    expect(g.minLon).toBeLessThanOrEqual(b.minLon);
    expect(g.minLat + (g.nLat - 1) * g.step).toBeGreaterThanOrEqual(b.maxLat);
    expect(g.minLon + (g.nLon - 1) * g.step).toBeGreaterThanOrEqual(b.maxLon);
    // Nodes must sit on the model's native 0.25 degree grid
    expect((g.step / 0.25) % 1).toBe(0);
    expect((g.minLat / 0.25) % 1).toBe(0);
    expect((g.minLon / 0.25) % 1).toBe(0);
  });

  describe('real terrain', () => {
    beforeAll(() => setTerrainRaster(loadBakedTerrain()));
    afterAll(() => setTerrainRaster(null));

    it('should use a flat fallback until the raster is installed', () => {
      setTerrainRaster(null);
      expect(getRegionalElevation(11.4, 76.735)).toBe(TERRAIN_FALLBACK_METERS);
      setTerrainRaster(loadBakedTerrain());
    });

    it('should reject a raster of the wrong size', () => {
      expect(() => setTerrainRaster(new Uint16Array(10))).toThrow();
    });

    it('should resolve the Nilgiris and the other high ranges', () => {
      expect(getRegionalElevation(11.402, 76.735)).toBeGreaterThan(2200); // Doddabetta
      expect(getRegionalElevation(10.238, 77.489)).toBeGreaterThan(1800); // Kodaikanal
      expect(getRegionalElevation(11.78, 78.21)).toBeGreaterThan(1200);   // Yercaud (Shevaroys)
      expect(getRegionalElevation(11.85, 78.68)).toBeGreaterThan(700);    // Kalrayan Hills
    });

    it('should resolve plains, coast and sea', () => {
      const madurai = getRegionalElevation(9.925, 78.12);
      expect(madurai).toBeGreaterThan(80);
      expect(madurai).toBeLessThan(220);

      expect(getRegionalElevation(13.05, 80.282)).toBeLessThan(25); // Chennai coast
      expect(getRegionalElevation(10.0, 80.2)).toBe(0);             // Bay of Bengal
      expect(getRegionalElevation(9.0, 78.9)).toBe(0);              // Gulf of Mannar
    });

    it('should show the Palghat Gap lower than the ranges either side of it', () => {
      const gap = getRegionalElevation(10.78, 76.7);
      expect(getRegionalElevation(11.4, 76.735)).toBeGreaterThan(gap + 1000);
      expect(getRegionalElevation(10.5, 77.0)).toBeGreaterThan(gap);
    });

    it('should clamp points outside the domain to the edge', () => {
      expect(getRegionalElevation(20, 90)).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(getRegionalElevation(-5, 60))).toBe(true);
    });

    it('should place every landmark on land at a sensible height', () => {
      for (const l of TAMIL_NADU_LANDMARKS) {
        expect(getRegionalElevation(l.lat, l.lon)).toBeGreaterThanOrEqual(0);
      }
      const doddabetta = TAMIL_NADU_LANDMARKS.find(l => l.id === 'doddabetta')!;
      const marina = TAMIL_NADU_LANDMARKS.find(l => l.id === 'marina')!;
      expect(getRegionalElevation(doddabetta.lat, doddabetta.lon)).toBeGreaterThan(2000);
      expect(getRegionalElevation(marina.lat, marina.lon)).toBeLessThan(25);
    });
  });

  it('should list all 38 district headquarters inside the domain', () => {
    expect(TAMIL_NADU_CITIES).toHaveLength(38);
    expect(SOUTH_INDIA_CITIES).toBe(TAMIL_NADU_CITIES);
    expect(new Set(TAMIL_NADU_CITIES.map(c => c.id)).size).toBe(38);
    expect(new Set(TAMIL_NADU_CITIES.map(c => c.name)).size).toBe(38);
    expect(TAMIL_NADU_CITIES.filter(c => c.tier === 1)).toHaveLength(10);

    for (const city of TAMIL_NADU_CITIES) {
      expect(city.lat).toBeGreaterThanOrEqual(REGIONAL_500M_BOUNDS.minLat);
      expect(city.lat).toBeLessThanOrEqual(REGIONAL_500M_BOUNDS.maxLat);
      expect(city.lon).toBeGreaterThanOrEqual(REGIONAL_500M_BOUNDS.minLon);
      expect(city.lon).toBeLessThanOrEqual(REGIONAL_500M_BOUNDS.maxLon);
    }
    for (const required of ['Chennai', 'Coimbatore', 'Madurai', 'Kallakurichi', 'Tenkasi', 'Mayiladuthurai', 'Ooty']) {
      expect(TAMIL_NADU_CITIES.some(c => c.name === required)).toBe(true);
    }
  });

  it('should find the nearest district headquarters and describe terrain', () => {
    expect(nearestCity(9.93, 78.12).city.name).toBe('Madurai');
    expect(nearestCity(9.93, 78.12).km).toBeLessThan(2);
    expect(nearestCity(13.0, 80.3).city.name).toBe('Chennai');
    expect(nearestCity(8.2, 77.4).city.name).toBe('Nagercoil');

    expect(describeTerrain(2200)).toBe('High-range hills');
    expect(describeTerrain(900)).toBe('Hill country');
    expect(describeTerrain(300)).toBe('Upland plateau');
    expect(describeTerrain(100)).toBe('Inland plains');
    expect(describeTerrain(5)).toBe('Coastal plain');
  });

  it('should downscale with the standard lapse rate and bounded orographic effects', () => {
    expect(downscaleTemperature(35, 0)).toBe(35);
    expect(downscaleTemperature(35, 1000)).toBeCloseTo(28.5, 5);
    expect(downscaleTemperature(35, 2000)).toBeLessThan(downscaleTemperature(35, 1000));

    expect(orographicFraction(-300)).toBe(0);
    expect(orographicFraction(600)).toBeCloseTo(0.5, 5);
    expect(orographicFraction(5000)).toBe(1);

    expect(windSpeedup(0)).toBe(1);
    expect(windSpeedup(1)).toBeCloseTo(1.35, 5);

    // Terrain above the model surface is more humid, below it drier; always bounded
    expect(downscaleHumidity(60, 500)).toBeGreaterThan(60);
    expect(downscaleHumidity(60, -500)).toBeLessThan(60);
    expect(downscaleHumidity(97, 2000)).toBe(98);
    expect(downscaleHumidity(20, -2000)).toBe(15);

    expect(downscaleRain(10, 1)).toBeCloseTo(14, 5);
    expect(downscaleRain(10, 0)).toBe(10);
    expect(downscaleCape(1000, 1)).toBe(780);
    expect(downscaleCape(1000, 0)).toBe(1000);
  });

  it('should convert wind degrees to correct compass headings', () => {
    expect(degToCompass(0)).toBe('N');
    expect(degToCompass(90)).toBe('E');
    expect(degToCompass(140)).toBe('SE');
    expect(degToCompass(150)).toBe('SSE');
    expect(degToCompass(180)).toBe('S');
    expect(degToCompass(270)).toBe('W');
    expect(degToCompass(-45)).toBe('NW');
  });

  it('should match user-requested Palette 1 for Temperature and Palette 2 for Humidity', () => {
    expect(TEMP_PALETTE_HEX).toEqual(['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51']);
    expect(HUMIDITY_PALETTE_HEX).toEqual(['#f7f7ef', '#ddddd4', '#9fb9cb', '#355c77', '#07253a']);

    expect(TEMP_PALETTE_RGB).toHaveLength(5);
    expect(TEMP_PALETTE_RGB[0]).toEqual([38, 70, 83]);
    expect(TEMP_PALETTE_RGB[4]).toEqual([231, 111, 81]);

    expect(HUMIDITY_PALETTE_RGB).toHaveLength(5);
    expect(HUMIDITY_PALETTE_RGB[0]).toEqual([247, 247, 239]);
    expect(HUMIDITY_PALETTE_RGB[4]).toEqual([7, 37, 58]);
  });

  it('should support elevation range from Ground Level (0m) to 13 km (13,000m)', () => {
    expect(ELEVATION_PRESETS[0].meters).toBe(0);
    expect(ELEVATION_PRESETS[ELEVATION_PRESETS.length - 1].meters).toBe(13000);

    const testLevels = [
      { altitudeMeters: 0, pressureHpa: 1013, label: 'Ground Level (Surface)', tempC: 31.5, humidityPercent: 58, windSpeedKmh: 6.5, windDirectionDeg: 140 },
      { altitudeMeters: 1500, pressureHpa: 850, label: '1.5 km (850 hPa Cloud Base)', tempC: 21.7, humidityPercent: 75, windSpeedKmh: 18.5, windDirectionDeg: 95 },
      { altitudeMeters: 5500, pressureHpa: 500, label: '5.5 km (500 hPa Freezing)', tempC: -4.0, humidityPercent: 42, windSpeedKmh: 22.0, windDirectionDeg: 85 },
      { altitudeMeters: 13000, pressureHpa: 150, label: '13.0 km (150 hPa Tropopause)', tempC: -64.0, humidityPercent: 25, windSpeedKmh: 38.0, windDirectionDeg: 65 }
    ];

    // At Ground level (0m)
    const ground = interpolateAtmosphericSounding(testLevels, 0);
    expect(ground.temperatureC).toBe(31.5);
    expect(ground.humidityPercent).toBe(58);
    expect(ground.levelLabel).toContain('Ground');

    // At 5.5 km (500 hPa freezing level)
    const midTropo = interpolateAtmosphericSounding(testLevels, 5500);
    expect(midTropo.temperatureC).toBe(-4.0);
    expect(midTropo.humidityPercent).toBe(42);

    // At 13 km (tropopause level)
    const tropopause = interpolateAtmosphericSounding(testLevels, 13000);
    expect(tropopause.temperatureC).toBe(-64.0);
    expect(tropopause.humidityPercent).toBe(25);

    // Mid-level interpolation (3500m)
    const midLevel = interpolateAtmosphericSounding(testLevels, 3500);
    expect(midLevel.temperatureC).toBeLessThan(21.7);
    expect(midLevel.temperatureC).toBeGreaterThan(-4.0);
  });

  it('should define IMD 24h Extreme Rain and WMO CAPE palettes correctly', () => {
    expect(RAIN_PALETTE_HEX).toHaveLength(7);
    expect(RAIN_PALETTE_RGB).toHaveLength(7);
    expect(RAIN_PALETTE_HEX[0]).toBe('#f8fafc'); // Trace / dry
    expect(RAIN_PALETTE_HEX[6]).toBe('#a855f7'); // Extreme > 204mm (purple)

    expect(CAPE_PALETTE_HEX).toHaveLength(7);
    expect(CAPE_PALETTE_RGB).toHaveLength(7);
    expect(CAPE_PALETTE_HEX[0]).toBe('#64748b'); // Stable (slate)
    expect(CAPE_PALETTE_HEX[6]).toBe('#d946ef'); // Extreme > 4500 J/kg (magenta)
  });

  it('should categorize 24-hour rainfall according to official IMD alert thresholds', () => {
    expect(getRainRiskLabel(0)).toContain('Very Light Rain');
    expect(getRainRiskLabel(10)).toContain('Light Rain');
    expect(getRainRiskLabel(40)).toContain('Moderate Rain');
    expect(getRainRiskLabel(85)).toContain('Heavy Rain Alert');
    expect(getRainRiskLabel(150)).toContain('Very Heavy Rain Warning');
    expect(getRainRiskLabel(250)).toContain('Extremely Heavy Rain');
  });

  it('should categorize CAPE convective storm instability according to WMO meteorological standards', () => {
    expect(getCapeRiskLabel(200)).toContain('Stable Air');
    expect(getCapeRiskLabel(800)).toContain('Marginal Convective Potential');
    expect(getCapeRiskLabel(1800)).toContain('Moderate Thunderstorm Risk');
    expect(getCapeRiskLabel(2800)).toContain('High Severe Storm Risk');
    expect(getCapeRiskLabel(4000)).toContain('Violent Convective Storms');
    expect(getCapeRiskLabel(5200)).toContain('Extreme Explosive Instability');
  });
});
