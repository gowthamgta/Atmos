import { describe, expect, it } from 'vitest';
import { terrainOnGrid } from './forecast-map.controller';
import { ForecastGrid } from './forecast.model';

const grid = (latMin: number, latMax: number, lonMin: number, lonMax: number, step: number): ForecastGrid => ({
  latMin, latMax, lonMin, lonMax, step,
  nx: Math.round((lonMax - lonMin) / step) + 1,
  ny: Math.round((latMax - latMin) / step) + 1,
});

describe('terrain on a forecast grid', () => {
  const southTerrain = grid(5.5, 14.5, 73, 89.5, 0.1);

  it('applies the South India terrain to an all-India field on the same lattice', () => {
    const india = grid(5, 37.5, 68, 97.5, 0.1);
    expect(terrainOnGrid(india, southTerrain)).toBe(true);
  });

  it('applies the terrain to the field it was built for', () => {
    expect(terrainOnGrid(southTerrain, southTerrain)).toBe(true);
  });

  it('does not apply it to a field that does not cover the terrain box', () => {
    expect(terrainOnGrid(grid(6, 20, 73, 90, 0.1), southTerrain)).toBe(false);
  });

  it('does not apply it when the spacing or the lattice differs', () => {
    expect(terrainOnGrid(grid(5, 37.5, 68, 97.5, 0.25), southTerrain)).toBe(false);
    expect(terrainOnGrid(grid(5.05, 37.55, 68.05, 97.55, 0.1), southTerrain)).toBe(false);
  });
});
