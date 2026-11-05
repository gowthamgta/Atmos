/** A box in degrees. */
export interface ClipBox {
  south: number;
  north: number;
  west: number;
  east: number;
}

type Position = number[];
type OutlineFeature = { type: 'Feature'; properties: Record<string, unknown> | null; geometry: { type: string; coordinates: unknown } | null };

/**
 * The outlines of polygon features as lines cut to a box (the owner, 6 Nov 2026: "remove the state lines for the hidden ones"): each ring
 * becomes the runs of it that lie inside the box, so a state reaching out of the forecast box keeps only the part of its border inside it.
 * Line features are cut the same way; the properties are kept.
 */
export function clipOutlines(fc: { type: 'FeatureCollection'; features: unknown[] }, box: ClipBox): { type: 'FeatureCollection'; features: OutlineFeature[] } {
  const features: OutlineFeature[] = [];
  for (const raw of fc.features as OutlineFeature[]) {
    const g = raw.geometry;
    if (!g) continue;
    const lines: Position[][] =
      g.type === 'Polygon' ? (g.coordinates as Position[][]) :
      g.type === 'MultiPolygon' ? (g.coordinates as Position[][][]).flat() :
      g.type === 'LineString' ? [g.coordinates as Position[]] :
      g.type === 'MultiLineString' ? (g.coordinates as Position[][]) : [];
    const runs = lines.flatMap(line => clipLine(line, box));
    if (runs.length) features.push({ type: 'Feature', properties: raw.properties, geometry: { type: 'MultiLineString', coordinates: runs } });
  }
  return { type: 'FeatureCollection', features };
}

/** The parts of a line inside the box, as separate runs (Liang-Barsky on each segment). */
export function clipLine(line: readonly Position[], box: ClipBox): Position[][] {
  const runs: Position[][] = [];
  let run: Position[] | null = null;
  for (let i = 1; i < line.length; i++) {
    const seg = clipSegment(line[i - 1], line[i], box);
    if (!seg) {
      run = null;
      continue;
    }
    const [a, b] = seg;
    const joins = run && run[run.length - 1][0] === a[0] && run[run.length - 1][1] === a[1];
    if (!joins) {
      run = [a];
      runs.push(run);
    }
    run!.push(b);
  }
  return runs;
}

function clipSegment(p: Position, q: Position, box: ClipBox): [Position, Position] | null {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [[-dx, p[0] - box.west], [dx, box.east - p[0]], [-dy, p[1] - box.south], [dy, box.north - p[1]]];
  for (const [pk, qk] of edges) {
    if (pk === 0) {
      if (qk < 0) return null;
      continue;
    }
    const r = qk / pk;
    if (pk < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  const at = (t: number): Position => (t === 0 ? p : t === 1 ? q : [p[0] + t * dx, p[1] + t * dy]);
  return [at(t0), at(t1)];
}
