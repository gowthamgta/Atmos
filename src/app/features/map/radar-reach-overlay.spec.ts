import { REACH_BOX, reachGeometry } from './radar-reach-overlay';

describe('grey where no radar reaches', () => {
  it('cuts a clear circle of each radar range out of the grey, at its place', () => {
    const g = reachGeometry([{ lat: 13.0839, lng: 80.2901, rangeKm: 250 }], 2000);
    const kmPerPx = (((REACH_BOX.east - REACH_BOX.west) / 360) * 40_075.017 * Math.cos((13.0839 * Math.PI) / 180)) / 2000;
    const c = g.circles[0];
    expect(c.x).toBeCloseTo(((80.2901 - REACH_BOX.west) / (REACH_BOX.east - REACH_BOX.west)) * 2000, 3);
    expect(c.r * kmPerPx).toBeCloseTo(250, 0); // the range on the ground
    expect(c.y).toBeGreaterThan(0);
    expect(c.y).toBeLessThan(g.height);
    expect(g.height).toBeGreaterThan(1500); // Mercator: taller than wide over these latitudes
  });

  it('is all grey with no radar working', () => {
    expect(reachGeometry([]).circles).toEqual([]);
  });
});
