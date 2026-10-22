/**
 * How the clouds moved between two satellite pictures, so the loop can show them moving instead of fading one picture into the next.
 *
 * Each picture leaves the worker with a small grid of how much cloud is where (`motionGrid`: brightness x opacity of the finished overlay, on its
 * Mercator rows). Between two of them, blocks of the first are searched for in the second a few pixels around (block matching); a block with no
 * cloud texture says nothing and takes its neighbours' motion; the field is then smoothed, since clouds move together over tens of kilometres.
 * The layer draws an in-between time t by taking the first picture from t of the way back along the motion and the second from the rest of the
 * way forward, and mixing them: at the pictures' own times nothing changes, so their colours stay exactly as they are.
 */

/** Width of the motion grid: about 6 km a cell over India, fine enough for 15 minutes of cloud motion. */
export const MOTION_W = 480;
/** Nodes of the field every this many grid cells, each matched with a block of twice the size. */
const STEP = 12;
const HALF = 8;
/** The furthest a block is looked for (grid cells): about 30 km in 15 minutes, 120 km/h. */
const RADIUS = 5;
/** A block whose brightness varies less than this (on 0-255) has no texture to match. */
const MIN_SPREAD = 6;

export interface MotionGrid {
  data: Uint8Array;
  w: number;
  h: number;
}

export interface FlowField {
  cols: number;
  rows: number;
  /** dx, dy of each node in turn, as fractions of the picture's width and height (from the first picture to the second). */
  data: Float32Array;
  /** Where the first node sits and how far apart the nodes are, as fractions of the picture's width and height. */
  x0: number;
  y0: number;
  stepX: number;
  stepY: number;
}

/** The motion grid of a finished overlay (RGBA, straight colour): brightness weighted by opacity, averaged down to MOTION_W wide. */
export function motionGrid(pixels: Uint8ClampedArray | Uint8Array, width: number, height: number, outW = MOTION_W): MotionGrid {
  const w = Math.min(outW, width);
  const h = Math.max(1, Math.round((height * w) / width));
  const sum = new Float32Array(w * h);
  const count = new Uint16Array(w * h);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(h - 1, Math.floor((y * h) / height));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(w - 1, Math.floor((x * w) / width));
      const o = (y * width + x) * 4;
      const v = ((pixels[o] + pixels[o + 1] + pixels[o + 2]) / 3) * (pixels[o + 3] / 255);
      sum[gy * w + gx] += v;
      count[gy * w + gx]++;
    }
  }
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = count[i] ? Math.round(sum[i] / count[i]) : 0;
  return { data, w, h };
}

/** The best shift (dx, dy) of the block around (cx, cy) of `a` in `b`, or null when the block has no texture. */
function matchBlock(a: MotionGrid, b: MotionGrid, cx: number, cy: number): [number, number] | null {
  const { w, h } = a;
  let lo = 255;
  let hi = 0;
  for (let y = cy - HALF; y < cy + HALF; y++) {
    for (let x = cx - HALF; x < cx + HALF; x++) {
      const v = a.data[y * w + x];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (hi - lo < MIN_SPREAD) return null;
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      if (cy - HALF + dy < 0 || cy + HALF + dy > h || cx - HALF + dx < 0 || cx + HALF + dx > w) continue;
      let sad = 0;
      for (let y = cy - HALF; y < cy + HALF && sad <= best; y++) { // stops once worse than the best (an equal one is summed in full)
        const ra = y * w;
        const rb = (y + dy) * w + dx;
        for (let x = cx - HALF; x < cx + HALF; x++) sad += Math.abs(a.data[ra + x] - b.data[rb + x]);
      }
      // a tie goes to the smaller shift (a still cloud stays still)
      if (sad < best || (sad === best && dx * dx + dy * dy < bx * bx + by * by)) {
        best = sad;
        bx = dx;
        by = dy;
      }
    }
  }
  return [bx, by];
}

/** The cloud motion from `a` to `b` (two motion grids of the same size), smoothed; null when they differ in size. */
export function cloudFlow(a: MotionGrid, b: MotionGrid): FlowField | null {
  if (a.w !== b.w || a.h !== b.h) return null;
  const cols = Math.max(1, Math.floor((a.w - 2 * HALF) / STEP) + 1);
  const rows = Math.max(1, Math.floor((a.h - 2 * HALF) / STEP) + 1);
  const dx = new Float32Array(cols * rows);
  const dy = new Float32Array(cols * rows);
  const known = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const m = matchBlock(a, b, HALF + c * STEP, HALF + r * STEP);
      if (!m) continue;
      dx[r * cols + c] = m[0];
      dy[r * cols + c] = m[1];
      known[r * cols + c] = 1;
    }
  }
  // nodes with no texture take the mean of their known neighbours, spreading out a few rings (beyond that: no motion)
  for (let pass = 0; pass < 4; pass++) {
    const next = known.slice();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (known[i]) continue;
        let sx = 0, sy = 0, n = 0;
        for (let rr = Math.max(0, r - 1); rr <= Math.min(rows - 1, r + 1); rr++) {
          for (let cc = Math.max(0, c - 1); cc <= Math.min(cols - 1, c + 1); cc++) {
            const j = rr * cols + cc;
            if (known[j]) { sx += dx[j]; sy += dy[j]; n++; }
          }
        }
        if (n) { dx[i] = sx / n; dy[i] = sy / n; next[i] = 1; }
      }
    }
    known.set(next);
  }
  // smoothed twice over the neighbours: single nodes that matched a different cloud do not tear the picture
  const smooth = (src: Float32Array): Float32Array => {
    const out = new Float32Array(src.length);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let s = 0, n = 0;
        for (let rr = Math.max(0, r - 1); rr <= Math.min(rows - 1, r + 1); rr++) {
          for (let cc = Math.max(0, c - 1); cc <= Math.min(cols - 1, c + 1); cc++) { s += src[rr * cols + cc]; n++; }
        }
        out[r * cols + c] = s / n;
      }
    }
    return out;
  };
  const sx = smooth(smooth(dx));
  const sy = smooth(smooth(dy));
  const data = new Float32Array(cols * rows * 2);
  for (let i = 0; i < cols * rows; i++) {
    data[i * 2] = sx[i] / a.w;
    data[i * 2 + 1] = sy[i] / a.h;
  }
  return { cols, rows, data, x0: HALF / a.w, y0: HALF / a.h, stepX: STEP / a.w, stepY: STEP / a.h };
}
