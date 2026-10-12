import { describe, expect, it } from 'vitest';
import { ForecastGrid } from './forecast.model';
import { Ground, groundAtFieldNodes, sameLattice } from './terrain-ground';

const grid = (latMin: number, latMax: number, lonMin: number, lonMax: number, step: number): ForecastGrid => ({
  latMin, latMax, lonMin, lonMax, step,
  nx: Math.round((lonMax - lonMin) / step) + 1,
  ny: Math.round((latMax - latMin) / step) + 1,
});

/** The India grid of the terrain (0.1 degree), and the two fields drawn against it. */
const TERRAIN = grid(5, 37.5, 68, 97.5, 0.1);
const IFS = grid(5, 37.5, 68, 97.5, 0.1);
const GFS = grid(5, 37.5, 68, 97.5, 0.25);

describe('which grids share a lattice', () => {
  it('is true for the grid itself, and for another with nodes on the same points (a smaller box)', () => {
    expect(sameLattice(IFS, TERRAIN)).toBe(true);
    expect(sameLattice(grid(5.5, 14.5, 73, 89.5, 0.1), TERRAIN)).toBe(true);
  });

  it('is false for another spacing, or nodes between the terrain\'s', () => {
    expect(sameLattice(GFS, TERRAIN)).toBe(false);                               // 0.25 degree: the GFS, AIGFS and AIFS pictures
    expect(sameLattice(grid(5.05, 37.55, 68.05, 97.55, 0.1), TERRAIN)).toBe(false);
  });
});

describe('the ground a field stands on, where its nodes are not the ground picture\'s', () => {
  /** A ground that is a ridge: 1000 m along lon 80.0, falling 500 m per degree away from it. Its land fraction is 1 east of 75, else 0. */
  const ridge = (_lat: number, lon: number): Ground => ({ z: Math.max(0, 1000 - 500 * Math.abs(lon - 80)), land: lon >= 75 ? 1 : 0 });

  it('reads the ground at the four nodes of the field around the point and interpolates them as the field is', () => {
    // GFS nodes in longitude are at 79.75 and 80.00: the ridge crest is exactly on a node
    const at = (lon: number) => groundAtFieldNodes(ridge, GFS, 20, lon).z;
    expect(at(80.0)).toBeCloseTo(1000, 6);               // on the node: its own ground
    expect(at(79.75)).toBeCloseTo(875, 6);               // on the next node: its ground (1000 - 500 * 0.25)
    expect(at(79.875)).toBeCloseTo((875 + 1000) / 2, 6); // half way: the average of the two nodes
  });

  it('does not see the ridge between nodes that the picture was never sampled on', () => {
    // nodes at 80.25 and 80.5 (ridge at 80.0 lies outside them): the ground between them is the line between their two heights, whatever lies below
    const spike = (_la: number, lo: number): Ground => ({ z: Math.abs(lo - 80.375) < 0.01 ? 3000 : 100, land: 1 });
    expect(groundAtFieldNodes(spike, GFS, 20, 80.375).z).toBeCloseTo(100, 6);        // the picture is a straight line between 100 and 100 here
    expect(spike(20, 80.375).z).toBe(3000);                                          // read straight at the point, it would have been the spike
  });

  it('interpolates both ways, and carries the land fraction along', () => {
    const slope = (lat: number, lon: number): Ground => ({ z: lat * 10 + lon, land: lon > 76 ? 1 : 0 });
    const mid = groundAtFieldNodes(slope, GFS, 20.125, 70.125);
    expect(mid.z).toBeCloseTo(20.125 * 10 + 70.125, 6);                              // a plane stays a plane
    expect(mid.land).toBe(0);
    expect(groundAtFieldNodes(slope, GFS, 20, 90).land).toBe(1);
  });

  it('clamps at the edge of the field instead of reading beyond it', () => {
    const east = groundAtFieldNodes(ridge, GFS, 20, 120);
    const last = groundAtFieldNodes(ridge, GFS, 20, GFS.lonMax);
    expect(east.z).toBeCloseTo(last.z, 3);
    expect(Number.isFinite(groundAtFieldNodes(ridge, GFS, 90, 10).z)).toBe(true);
  });

  it('gives what reading the picture directly gives when the field is on the picture\'s own lattice', () => {
    // the shader and the click card skip the node reading in that case; the two answers have to agree there
    const plane = (lat: number, lon: number): Ground => ({ z: 100 + 3 * lat + 2 * lon, land: 1 });
    for (const [lat, lon] of [[12.34, 78.91], [20.02, 70.5], [36.9, 97.1]]) {
      expect(groundAtFieldNodes(plane, IFS, lat, lon).z).toBeCloseTo(plane(lat, lon).z, 6);
    }
  });
});
