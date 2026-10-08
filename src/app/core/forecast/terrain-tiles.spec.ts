import { describe, expect, it } from 'vitest';
import {
  TILE_NONE,
  TILE_SEA,
  TileSlots,
  buildTileMap,
  decodeTilePixel,
  sampleTile,
  terrainLevelForZoom,
  tileAtCell,
  tileGridOf,
  tileName,
  tileNameAt,
  tilesInBounds,
} from './terrain-tiles';

const DOMAIN = { latMax: 14.5, latMin: 5.5, lonMin: 73.0, lonMax: 89.5 };

describe('terrain tiles', () => {
  it('picks the detail level from the zoom: 90 m only when zoomed in', () => {
    expect(terrainLevelForZoom(12)).toBe(0);
    expect(terrainLevelForZoom(9.5)).toBe(0);
    expect(terrainLevelForZoom(9.49)).toBe(1);
    expect(terrainLevelForZoom(7.5)).toBe(1);
    expect(terrainLevelForZoom(6.2)).toBe(2);
    expect(terrainLevelForZoom(3)).toBe(2);
  });

  it('names a tile by its south-west corner, padded like the files', () => {
    expect(tileNameAt(11.74, 78.96)).toBe('N11E078');
    expect(tileNameAt(8.08, 77.54)).toBe('N08E077');
    expect(tileName(5, 73)).toBe('N05E073');
  });

  it('lays the tile grid over the domain: whole degrees, row 0 in the north', () => {
    const grid = tileGridOf(DOMAIN);
    expect(grid).toEqual({ lonMin: 73, latTop: 15, cols: 17, rows: 10 });
    expect(tileAtCell(grid, 5, 0)).toBe('N14E078');
    expect(tileAtCell(grid, 0, 9)).toBe('N05E073');
  });

  it('lists only the tiles with ground that a view touches', () => {
    const grid = tileGridOf(DOMAIN);
    const present = new Set(['N11E078', 'N11E079', 'N12E078', 'N12E079', 'N13E078']);
    const view = { west: 78.5, east: 79.5, south: 11.5, north: 12.0 };
    expect(tilesInBounds(grid, view, present).sort()).toEqual(['N11E078', 'N11E079', 'N12E078', 'N12E079']);
    // a view over open sea has no tiles to load
    expect(tilesInBounds(grid, { west: 85, east: 86, south: 6, north: 7 }, present)).toEqual([]);
  });

  it('maps every tile: a slot where it is held, sea where there is no file, none where it is not held', () => {
    const grid = tileGridOf(DOMAIN);
    const present = new Set(['N11E078', 'N11E079']);
    const slots = new Map([['N11E078', 3]]);
    const map = buildTileMap(grid, present, slots);
    const at = (name: string) => {
      for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) if (tileAtCell(grid, c, r) === name) return map[r * grid.cols + c];
      throw new Error(name);
    };
    expect(at('N11E078')).toBe(3);
    expect(at('N11E079')).toBe(TILE_NONE);     // has ground, but is not held on the GPU
    expect(at('N10E078')).toBe(TILE_SEA);      // no file: open sea
  });
});

describe('tile slots on the GPU', () => {
  it('takes free slots first, then evicts the least recently used tile that is not on screen', () => {
    const slots = new TileSlots(2);
    const onScreen = new Set(['A', 'B']);
    expect(slots.assign('A', onScreen)).toBe(0);
    expect(slots.assign('B', onScreen)).toBe(1);
    slots.touch(['A']);
    slots.touch(['B']);                          // B is the most recently used
    // C is on screen now and A and B are not: A is the least recently used of them
    expect(slots.assign('C', new Set(['C']))).toBe(0);
    expect(slots.has('A')).toBe(false);
    expect(slots.slot('B')).toBe(1);
  });

  it('never evicts a tile that is on screen, and gives up when every slot holds one', () => {
    const slots = new TileSlots(2);
    slots.assign('A', new Set(['A', 'B']));
    slots.assign('B', new Set(['A', 'B']));
    expect(slots.assign('C', new Set(['A', 'B', 'C']))).toBeNull();
    expect(slots.has('A') && slots.has('B')).toBe(true);
  });

  it('keeps a tile in its slot while it is held', () => {
    const slots = new TileSlots(3);
    expect(slots.assign('A', new Set())).toBe(0);
    expect(slots.assign('A', new Set())).toBe(0);
    expect(slots.resident().size).toBe(1);
  });
});

describe('sampling a tile', () => {
  const N = 4;
  /** A 4 x 4 tile whose metres rise from 100 m in the north-west corner in steps of 100 m per cell to the east. */
  function ramp(): Uint8ClampedArray {
    const out = new Uint8ClampedArray(N * N * 4);
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const q = Math.round(((100 * (c + 1)) / 4000) * 65535);
        const i = (r * N + c) * 4;
        out[i] = q >> 8;
        out[i + 1] = q & 255;
        out[i + 2] = 255;                       // land
      }
    }
    return out;
  }

  it('decodes metres and land from a pixel', () => {
    expect(decodeTilePixel(0, 0, 0, 4000)).toEqual({ z: 0, land: 0 });
    const d = decodeTilePixel(...([(65535 >> 8), 65535 & 255, 255] as [number, number, number]), 4000);
    expect(d.z).toBeCloseTo(4000, 6);
    expect(d.land).toBe(1);
  });

  it('interpolates between cell centres and clamps at the tile edge', () => {
    const rgba = ramp();
    // the centre of column 0 is at 0.5 / N of the tile's width: metres 100
    expect(sampleTile(rgba, N, 0.5, 0.5 / N, 4000).z).toBeCloseTo(100, 1);
    // halfway between columns 0 and 1 (metres 100 and 200)
    expect(sampleTile(rgba, N, 0.5, 1 / N, 4000).z).toBeCloseTo(150, 1);
    // beyond the east edge the last column's metres hold
    expect(sampleTile(rgba, N, 0.5, 0.999, 4000).z).toBeCloseTo(400, 1);
  });
});
