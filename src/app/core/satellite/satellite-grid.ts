/**
 * The data pack's grid (square Mercator pixels, about 3 km over India) and the window sums the synthetic radar reads it with: shared by the
 * hand-set rules (synthetic-radar.ts) and the learned model's inputs (rain-features.ts).
 */

export const EARTH_KM = 40_075.017;

export const mercY = (lat: number): number => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

export const latOfMercY = (y: number): number => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

export const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Summed-area table (one row and column of zeros in front). */
export function summed(values: Float32Array, w: number, h: number, map: (v: number) => number): Float64Array {
  const t = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += map(values[y * w + x]);
      t[(y + 1) * (w + 1) + x + 1] = t[y * (w + 1) + x + 1] + row;
    }
  }
  return t;
}

export function boxSum(t: Float64Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): number {
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(w - 1, x1);
  y1 = Math.min(h - 1, y1);
  if (x1 < x0 || y1 < y0) return 0;
  const W = w + 1;
  return t[(y1 + 1) * W + x1 + 1] - t[y0 * W + x1 + 1] - t[(y1 + 1) * W + x0] + t[y0 * W + x0];
}

/** The third least of eight values. */
export function thirdLeast(v: Float64Array): number {
  let a = Infinity, b = Infinity, c = Infinity;
  for (let k = 0; k < 8; k++) {
    const x = v[k];
    if (x < a) [a, b, c] = [x, a, b];
    else if (x < b) [b, c] = [x, b];
    else if (x < c) c = x;
  }
  return c;
}

/** The sun's height (degrees) at a place and time (a solar-position formula good to about a degree). */
export function sunHeightDeg(timeMs: number, lat: number, lon: number): number {
  const d = new Date(timeMs);
  const doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000;
  const g = ((2 * Math.PI) / 365) * (doy - 1 + (d.getUTCHours() - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const la = (lat * Math.PI) / 180;
  const ha = (((utcMin + eqt + 4 * lon) / 4 - 180) * Math.PI) / 180;
  return (Math.asin(Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha)) * 180) / Math.PI;
}
