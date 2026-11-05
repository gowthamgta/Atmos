import { describe, expect, it } from 'vitest';
import { clipLine, clipOutlines } from './clip-outlines';

const BOX = { south: 0, north: 10, west: 0, east: 10 };

describe('clipOutlines', () => {
  it('keeps a line inside the box whole and cuts one crossing it at the edge', () => {
    expect(clipLine([[1, 1], [5, 5], [9, 1]], BOX)).toEqual([[[1, 1], [5, 5], [9, 1]]]);
    expect(clipLine([[5, 5], [15, 5]], BOX)).toEqual([[[5, 5], [10, 5]]]);
  });

  it('splits a line that leaves the box and comes back into two runs', () => {
    const runs = clipLine([[2, 5], [8, 5], [8, 15], [4, 15], [4, 8]], BOX);
    expect(runs).toEqual([[[2, 5], [8, 5], [8, 10]], [[4, 10], [4, 8]]]);
  });

  it('turns polygons into their outlines inside the box and drops those wholly outside', () => {
    const fc = {
      type: 'FeatureCollection' as const,
      features: [
        { type: 'Feature', properties: { kind: 'state', name: 'In and out' }, geometry: { type: 'Polygon', coordinates: [[[5, 5], [15, 5], [15, 8], [5, 8], [5, 5]]] } },
        { type: 'Feature', properties: { kind: 'state', name: 'Far' }, geometry: { type: 'Polygon', coordinates: [[[20, 20], [30, 20], [30, 30], [20, 20]]] } },
      ],
    };
    const out = clipOutlines(fc, BOX);
    expect(out.features.map(f => f.properties!['name'])).toEqual(['In and out']);
    expect(out.features[0].geometry).toEqual({ type: 'MultiLineString', coordinates: [[[5, 5], [10, 5]], [[10, 8], [5, 8], [5, 5]]] });
  });
});
