/**
 * Pure pixel maths for turning an EUMETView picture into a map overlay.
 *
 * The service returns plain latitude/longitude pictures, but the map is Mercator, where each degree of latitude is
 * taller than the last one going north. So the picture's rows are re-spaced to Mercator before it is placed on the
 * map, and its dark or empty parts are made see-through.
 */
import {
  SATELLITE_BOUNDS,
  SatelliteChannel,
  TWILIGHT_BLEND_HI_DEG,
  TWILIGHT_BLEND_LO_DEG,
  sunElevationDeg,
} from './satellite.config';

const RAD = Math.PI / 180;

export function mercatorY(latDeg: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (latDeg * RAD) / 2));
}

export function latFromMercatorY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;
}

/** Output height that keeps square pixels on the Mercator map for a picture `width` pixels wide. */
export function mercatorHeight(width: number, b = SATELLITE_BOUNDS): number {
  const lonSpan = (b.east - b.west) * RAD;
  return Math.round((width * (mercatorY(b.north) - mercatorY(b.south))) / lonSpan);
}

/**
 * For each output row (top to bottom, evenly spaced in Mercator), the fractional row of the source picture
 * (top to bottom, evenly spaced in latitude) that it should show.
 */
export function mercatorRowMap(srcHeight: number, outHeight: number, b = SATELLITE_BOUNDS): Float32Array {
  const yTop = mercatorY(b.north);
  const yBottom = mercatorY(b.south);
  const rows = new Float32Array(outHeight);
  for (let r = 0; r < outHeight; r++) {
    const lat = latFromMercatorY(yTop + ((yBottom - yTop) * (r + 0.5)) / outHeight);
    const f = ((b.north - lat) / (b.north - b.south)) * srcHeight - 0.5;
    rows[r] = Math.min(Math.max(f, 0), srcHeight - 1);
  }
  return rows;
}

function smoothstep(lo: number, hi: number, v: number): number {
  const t = Math.min(Math.max((v - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Side of a JPEG block, and the biggest step (0-255 per channel) across a block edge that is treated as compression, not cloud. */
export const JPEG_BLOCK = 8;
export const DEBLOCK_MAX_STEP = 20;

/**
 * Smooths the faint steps JPEG compression leaves at the 8 x 8 block edges of an RGBA picture (in place; alpha is not
 * touched). Across each block edge the two pixels either side move towards each other, and their outer neighbours a
 * little, but only where the step is small. Real cloud edges (bigger steps) are left alone. Without this, sharpening
 * the picture at deep zoom would bring out the block grid.
 */
export function deblockJpeg(px: Uint8ClampedArray, width: number, height: number, maxStep = DEBLOCK_MAX_STEP): void {
  const stride = width * 4;
  const smooth = (i: number, step: number): void => {
    // i: index of the first pixel after the edge; step: distance in the array between neighbouring pixels across it
    for (let c = 0; c < 3; c++) {
      const a = px[i - step + c];
      const b = px[i + c];
      const d = b - a;
      if (d === 0 || Math.abs(d) > maxStep) continue;
      px[i - 2 * step + c] += 0.15 * d;
      px[i - step + c] = a + 0.35 * d;
      px[i + c] = b - 0.35 * d;
      px[i + step + c] -= 0.15 * d;
    }
  };
  for (let y = 0; y < height; y++) {
    for (let x = JPEG_BLOCK; x < width - 1; x += JPEG_BLOCK) smooth(y * stride + x * 4, 4);
  }
  for (let y = JPEG_BLOCK; y < height - 1; y += JPEG_BLOCK) {
    for (let x = 0; x < width; x++) smooth(y * stride + x * 4, stride);
  }
}

/**
 * The typical brightness of land and sea in the blue channel of an HRV picture: its median. Cloud covers well under
 * half of the area, so the median is the background, whatever the sun's height (it is low at dawn and dusk).
 */
export function hrvBackground(src: Uint8ClampedArray): number {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 2; i < src.length; i += 4 * 7) { // every 7th pixel is plenty
    if (src[i - 2] + src[i - 1] + src[i] < 12) continue; // empty corners are not background
    hist[src[i]]++;
    n++;
  }
  if (n === 0) return 60; // nothing to measure (an all-black picture): use a typical value
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= n / 2) return v;
  }
  return 60;
}

/**
 * Estimates Cloud-Top Temperature (°C) from normalized Meteosat IR10.8 brightness `luma` (0 = warm +30°C surface,
 * 1 = cold -85°C tropopause).
 */
export function irLumaToTempC(luma: number): number {
  const clamped = Math.min(Math.max(luma, 0), 1);
  return Math.round((30 - clamped * 115) * 10) / 10;
}

/**
 * Estimates tropical Cloud-Top Height (km) from Cloud-Top Temperature (°C) using a 6.2°C/km lapse rate from +28°C.
 */
export function irTempToHeightKm(tempC: number): number {
  if (tempC >= 24) return 0;
  return Math.min(17.5, Math.max(0, Math.round(((28 - tempC) / 6.2) * 10) / 10));
}

export interface CloudTopClassification {
  label: string;
  color: string;
}

/** Human-readable cloud regime and accent colour for a Cloud-Top Temperature (°C). */
export function classifyCloudTop(tempC: number): CloudTopClassification {
  if (tempC > 8) return { label: 'Clear / Warm surface', color: '#94a3b8' };
  if (tempC > -12) return { label: 'Low cloud / Cumulus', color: '#38bdf8' };
  if (tempC > -35) return { label: 'Mid-level cloud', color: '#06b6d4' };
  if (tempC > -55) return { label: 'High cloud / Cirrus anvil', color: '#facc15' };
  if (tempC > -70) return { label: 'Deep convection', color: '#f97316' };
  return { label: 'Overshooting top / Severe', color: '#f43f5e' };
}

/**
 * The night picture's colours for a cloud-top temperature (°C). The warm ground and sea (above about +25 °C) are left clear; low and
 * middle cloud, whose tops are +20 down to -25 °C in the tropics, is a soft white-grey that gets denser as the top gets colder, so it still reads as cloud; from high cloud upwards the colder the top the louder the colour (cyan, green, yellow,
 * orange, red, white at the coldest), which picks out the tall storm tops and the cirrus anvils.
 */
export const CLOUD_TOP_STOPS: readonly (readonly [number, number, number, number, number])[] = [
  // [tempC, R, G, B, alpha 0..255], warmest first
  [26, 200, 210, 225, 0],
  [20, 200, 210, 225, 55],
  [12, 205, 214, 228, 105],
  [4, 208, 217, 232, 140],
  [-10, 212, 220, 235, 170],
  [-25, 228, 234, 246, 200],
  [-40, 245, 248, 255, 228],
  [-50, 120, 220, 255, 235],
  [-58, 90, 235, 190, 240],
  [-65, 250, 225, 60, 245],
  [-72, 255, 140, 40, 250],
  [-79, 250, 60, 70, 252],
  [-85, 255, 255, 255, 255],
];

/** Colour and opacity (0..255) of a cloud top of this temperature (°C). */
export function cloudTopColor(tempC: number): [number, number, number, number] {
  const first = CLOUD_TOP_STOPS[0];
  if (tempC >= first[0]) return [first[1], first[2], first[3], first[4]];
  for (let i = 0; i < CLOUD_TOP_STOPS.length - 1; i++) {
    const a = CLOUD_TOP_STOPS[i];
    const b = CLOUD_TOP_STOPS[i + 1];
    if (tempC <= a[0] && tempC >= b[0]) {
      const t = (a[0] - tempC) / (a[0] - b[0]);
      return [
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
        Math.round(a[3] + (b[3] - a[3]) * t),
        Math.round(a[4] + (b[4] - a[4]) * t),
      ];
    }
  }
  const last = CLOUD_TOP_STOPS[CLOUD_TOP_STOPS.length - 1];
  return [last[1], last[2], last[3], last[4]];
}

/** The colour bar of the cloud-top picture as a CSS gradient from +20 °C (left) to -85 °C, matching what the map draws over a dark ground. */
export function cloudTopGradient(): string {
  const hi = 20;
  const lo = -85;
  const stops: string[] = [];
  for (let t = hi; t >= lo; t -= 5) {
    const [r, g, b, a] = cloudTopColor(t);
    stops.push(`rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)}) ${(((hi - t) / (hi - lo)) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/**
 * The share (0..1) of the infrared in the blue channel of an HRV picture: 0 for the warm ground and sea, 1 for the coldest top.
 * `background` is the typical blue of land and sea (see hrvBackground).
 */
function infraredShare(blue: number, background: number): number {
  const floor = Math.max(0, background - 18);
  return Math.min(1, Math.max(0, (blue - floor) / Math.max(1, 255 - floor)));
}

/**
 * Colour and opacity (0..255) of one pixel; the result is written into `out` at `o`.
 *
 * HRV (by day): the picture as the service draws it (yellow land, dark sea, white and lavender cloud); only true black, the
 * empty edge of the picture, is see-through. Where the HRV has no data (a large patch of the north-east, and the night side
 * at dawn and dusk) the service shows only the infrared in the blue channel, a violet patch, so there the infrared is drawn
 * instead as see-through white cloud, brighter and more solid the colder it is.
 *
 * Infrared (by night): the cloud-top colours (see cloudTopColor); the warm ground and sea are see-through.
 */
export function shadePixel(
  kind: SatelliteChannel,
  r: number,
  g: number,
  b: number,
  background: number,
  out: Uint8ClampedArray,
  o: number,
  keep = 1,
): void {
  if (r + g + b === 0) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    return;
  }
  if (kind === 'hrv') {
    const hrv = (r + g) / 2;
    // the edge of the HRV's data is antialiased, so a pixel there is a mix of the picture and the violet no-data colour: blue far above
    // the red and green (a real HRV pixel has about as much blue as red, or much less) counts as no data too, which clears the violet line
    const blueHeavy = smoothstep(1.7, 2.8, b / Math.max(hrv, 1));
    const hasHrv = Math.min(smoothstep(2, 7, hrv), 1 - blueHeavy);
    // `keep` (see hrvCloudKeep) is how much of the pixel is cloud rather than clear ground; its colour is left as it is
    const hrvAlpha = smoothstep(3, 14, Math.max(r, g, b)) * keep;
    if (hasHrv >= 1) {
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
      out[o + 3] = Math.round(255 * hrvAlpha);
      return;
    }
    const ir = infraredShare(b, background);
    const fillAlpha = smoothstep(0.22, 0.6, ir) * 0.92;
    const fill = 175 + 80 * smoothstep(0.1, 0.9, ir);
    // premultiplied mix of the HRV pixel (where it has data) and the infrared fill, so the edge of the data has no seam
    const wHrv = hrvAlpha * hasHrv;
    const wFill = fillAlpha * (1 - hasHrv);
    const total = wHrv + wFill;
    if (total <= 0) {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      return;
    }
    out[o] = (r * wHrv + fill * wFill) / total;
    out[o + 1] = (g * wHrv + fill * wFill) / total;
    out[o + 2] = (b * wHrv + Math.min(255, fill + 8) * wFill) / total;
    out[o + 3] = Math.round(255 * Math.min(1, total));
    return;
  }
  const [cr, cg, cb, ca] = cloudTopColor(irLumaToTempC((r + g + b) / 3 / 255));
  out[o] = cr; out[o + 1] = cg; out[o + 2] = cb; out[o + 3] = ca;
}

// ── Ground removal (HRV by day) ──
// The picture's land is yellow and its sea dark. Cloud is whatever stands out from the clear ground around it: brighter (low, sunlit
// cloud, which stays yellowish) or colder (the blue channel is the infrared: high cloud is white and lavender). The ground under each place
// is the low end (22nd percentile) of the picture over about 65 km around it, which cloud never is, measured on a coarse grid. A pixel's own
// colour is never changed: only its opacity says how much of it is cloud, so low and high cloud still differ in colour. The measure errs towards keeping.
const GROUND_PERCENTILE = 0.22;
const GROUND_RADIUS_KM = 65;
/** The excess over the ground (0 to 255) at which a pixel starts to count as cloud, and where it is all cloud. */
const KEEP_FROM = 7;
const KEEP_FULL = 30;

/** The `pct` percentile (0..1) of a coarse plane (values 0..255, -1 for no data) in a square window of `radius` around each cell. */
function windowPercentile(plane: Int16Array, w: number, h: number, radius: number, pct: number): Float32Array {
  const out = new Float32Array(w * h);
  const hist = new Int32Array(128);
  for (let y = 0; y < h; y++) {
    hist.fill(0);
    let n = 0;
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    const edit = (x: number, sign: number): void => {
      if (x < 0 || x >= w) return;
      for (let yy = y0; yy <= y1; yy++) {
        const v = plane[yy * w + x];
        if (v >= 0) {
          hist[v >> 1] += sign;
          n += sign;
        }
      }
    };
    for (let x = 0; x <= radius; x++) edit(x, 1);
    for (let x = 0; x < w; x++) {
      if (x > 0) {
        edit(x - radius - 1, -1);
        edit(x + radius, 1);
      }
      if (n === 0) {
        out[y * w + x] = 60;
        continue;
      }
      const target = n * pct;
      let acc = 0;
      let bin = 0;
      for (; bin < 127; bin++) {
        acc += hist[bin];
        if (acc >= target) break;
      }
      out[y * w + x] = bin * 2 + 1;
    }
  }
  return out;
}

/** The `pct` percentile (0..1) of all the valid cells (not -1) of a coarse plane. */
function planePercentile(plane: Int16Array, pct: number): number {
  const hist = new Int32Array(256);
  let n = 0;
  for (const v of plane) {
    if (v >= 0) {
      hist[v]++;
      n++;
    }
  }
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= n * pct) return v;
  }
  return 255;
}

/** Separable box blur of a plane, `passes` times (edges clamped), in place. */
function boxBlur(plane: Float32Array, w: number, h: number, radius: number, passes: number): void {
  const tmp = new Float32Array(plane.length);
  const norm = 1 / (2 * radius + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) s += plane[y * w + Math.min(w - 1, Math.max(0, x + k))];
        tmp[y * w + x] = s * norm;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
        plane[y * w + x] = s * norm;
      }
    }
  }
}

/** Morphological closing (square window of `radius`): fills holes and gaps narrower than 2 x radius + 1 pixels. */
function closeGaps(plane: Float32Array, w: number, h: number, radius: number): Float32Array {
  const pass = (src: Float32Array, horizontal: boolean, grow: boolean): Float32Array => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = grow ? 0 : 1;
        for (let k = -radius; k <= radius; k++) {
          const xx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
          const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
          const s = src[yy * w + xx];
          v = grow ? Math.max(v, s) : Math.min(v, s);
        }
        out[y * w + x] = v;
      }
    }
    return out;
  };
  return pass(pass(pass(pass(plane, true, true), false, true), true, false), false, false);
}

/**
 * How much of each pixel of an HRV picture is cloud (0 = the clear ground, 1 = cloud), from how far it stands out from the ground around
 * it. `width` x `height` is the picture, which covers `b`.
 */
export function hrvCloudKeep(src: Uint8ClampedArray, width: number, height: number, b = SATELLITE_BOUNDS): Float32Array {
  const midLat = (b.north + b.south) / 2;
  const kmPerPx = ((b.east - b.west) * 111.32 * Math.cos(midLat * RAD)) / width;
  const stride = Math.max(1, Math.round(width / 250));
  const gw = Math.ceil(width / stride);
  const gh = Math.ceil(height / stride);
  const lumPlane = new Int16Array(gw * gh).fill(-1);
  const bluePlane = new Int16Array(gw * gh).fill(-1);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const p = (Math.min(height - 1, gy * stride) * width + Math.min(width - 1, gx * stride)) * 4;
      if (src[p] + src[p + 1] + src[p + 2] < 12) continue; // the empty corners are not ground
      lumPlane[gy * gw + gx] = (src[p] + src[p + 1]) >> 1;
      bluePlane[gy * gw + gx] = src[p + 2];
    }
  }
  const radius = Math.min(14, Math.max(3, Math.round(GROUND_RADIUS_KM / (kmPerPx * stride))));
  const lumGround = windowPercentile(lumPlane, gw, gh, radius, GROUND_PERCENTILE);
  const blueGround = windowPercentile(bluePlane, gw, gh, radius, GROUND_PERCENTILE);
  // a cloud mass wider than the window would count as ground: the ground is never brighter than most of the whole picture
  const lumCap = planePercentile(lumPlane, 0.6);
  const blueCap = planePercentile(bluePlane, 0.6);
  for (let i = 0; i < lumGround.length; i++) {
    lumGround[i] = Math.min(lumGround[i], lumCap);
    blueGround[i] = Math.min(blueGround[i], blueCap);
  }
  boxBlur(lumGround, gw, gh, 2, 2);
  boxBlur(blueGround, gw, gh, 2, 2);

  // each column's and row's place on the coarse grid
  const cx0 = new Int32Array(width);
  const cx1 = new Int32Array(width);
  const cwx = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const f = Math.min(gw - 1, Math.max(0, (x + 0.5) / stride - 0.5));
    cx0[x] = Math.floor(f);
    cx1[x] = Math.min(gw - 1, cx0[x] + 1);
    cwx[x] = f - cx0[x];
  }
  const excess = new Float32Array(width * height);
  const keep = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const f = Math.min(gh - 1, Math.max(0, (y + 0.5) / stride - 0.5));
    const r0 = Math.floor(f) * gw;
    const r1 = Math.min(gh - 1, Math.floor(f) + 1) * gw;
    const wy = f - Math.floor(f);
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (src[p] + src[p + 1] + src[p + 2] < 12) continue;
      const bil = (plane: Float32Array): number =>
        (plane[r0 + cx0[x]] * (1 - cwx[x]) + plane[r0 + cx1[x]] * cwx[x]) * (1 - wy) + (plane[r1 + cx0[x]] * (1 - cwx[x]) + plane[r1 + cx1[x]] * cwx[x]) * wy;
      const e = Math.max((src[p] + src[p + 1]) / 2 - bil(lumGround), 0.8 * (src[p + 2] - bil(blueGround)));
      excess[y * width + x] = e;
      keep[y * width + x] = smoothstep(KEEP_FROM, KEEP_FULL, e);
    }
  }
  // thin cloud beside thick cloud belongs to it: strong opacity spreads two pixels, where there is some excess at all
  const rowMax = new Float32Array(keep.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let m = 0;
      for (let k = -2; k <= 2; k++) m = Math.max(m, keep[y * width + Math.min(width - 1, Math.max(0, x + k))]);
      rowMax[y * width + x] = m;
    }
  }
  const spread = new Float32Array(keep.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let m = 0;
      for (let k = -2; k <= 2; k++) m = Math.max(m, rowMax[Math.min(height - 1, Math.max(0, y + k)) * width + x]);
      spread[y * width + x] = m;
    }
  }
  for (let i = 0; i < keep.length; i++) keep[i] = Math.max(keep[i], 0.85 * spread[i] * smoothstep(3, 9, excess[i]));
  // a small hole in the middle of a cloud (a darker patch of the cloud itself) is not ground: close gaps up to 6 pixels
  const closed = closeGaps(keep, width, height, 3);
  for (let i = 0; i < keep.length; i++) keep[i] = Math.max(keep[i], 0.8 * closed[i]);
  boxBlur(keep, width, height, 1, 1);
  return keep;
}

/**
 * Re-space the rows of an RGBA picture to Mercator (linear blend between the two nearest source rows) and set colour and
 * opacity (see shadePixel). `src` is `width` x `srcHeight`; the result is `width` x `outHeight`.
 * When `twilightIr` and `timeMs` are provided for an HRV frame near sunrise/sunset, pixels on the dark side of the solar
 * terminator smoothly transition to the infrared picture instead of going black.
 */
export function toOverlayPixels(
  src: Uint8ClampedArray,
  width: number,
  srcHeight: number,
  kind: SatelliteChannel,
  outHeight = mercatorHeight(width, SATELLITE_BOUNDS),
  twilightIr?: Uint8ClampedArray,
  timeMs?: number,
  b = SATELLITE_BOUNDS,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * outHeight * 4);
  const rowMap = mercatorRowMap(srcHeight, outHeight, b);
  const background = kind === 'hrv' ? hrvBackground(src) : 0;
  const cloud = kind === 'hrv' ? hrvCloudKeep(src, width, srcHeight, b) : null;
  const irOverlay =
    twilightIr && kind === 'hrv' && timeMs !== undefined
      ? toOverlayPixels(twilightIr, width, srcHeight, 'ir', outHeight, undefined, undefined, b)
      : null;
  const yTop = mercatorY(b.north);
  const yBottom = mercatorY(b.south);

  for (let r = 0; r < outHeight; r++) {
    const f = rowMap[r];
    const y0 = Math.floor(f);
    const y1 = Math.min(y0 + 1, srcHeight - 1);
    const w = f - y0;
    const a = y0 * width * 4;
    const c = y1 * width * 4;
    const lat = irOverlay ? latFromMercatorY(yTop + ((yBottom - yTop) * (r + 0.5)) / outHeight) : 0;
    let o = r * width * 4;
    for (let x = 0; x < width; x++, o += 4) {
      const i = x * 4;
      shadePixel(
        kind,
        src[a + i] * (1 - w) + src[c + i] * w,
        src[a + i + 1] * (1 - w) + src[c + i + 1] * w,
        src[a + i + 2] * (1 - w) + src[c + i + 2] * w,
        background, out, o,
        cloud ? cloud[y0 * width + x] * (1 - w) + cloud[y1 * width + x] * w : 1,
      );
      if (irOverlay && timeMs !== undefined) {
        const lon = b.west + ((x + 0.5) / width) * (b.east - b.west);
        const dayW = smoothstep(TWILIGHT_BLEND_LO_DEG, TWILIGHT_BLEND_HI_DEG, sunElevationDeg(timeMs, lat, lon));
        if (dayW < 0.999) {
          const aDay = (out[o + 3] / 255) * dayW;
          const aNight = (irOverlay[o + 3] / 255) * (1 - dayW);
          const aMix = aDay + aNight;
          if (aMix <= 0) {
            out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
          } else {
            out[o] = (out[o] * aDay + irOverlay[o] * aNight) / aMix;
            out[o + 1] = (out[o + 1] * aDay + irOverlay[o + 1] * aNight) / aMix;
            out[o + 2] = (out[o + 2] * aDay + irOverlay[o + 2] * aNight) / aMix;
            out[o + 3] = aMix * 255;
          }
        }
      }
    }
  }
  return out;
}

export const LUMA_GRID_SIZE = 120;

export interface SatelliteHoverReading {
  lat: number;
  lon: number;
  tempC: number;
  heightKm: number;
  label: string;
  color: string;
}

/**
 * Downsamples a source satellite image (`width` x `height` in EPSG:4326) to a compact `gridSize` x `gridSize` IR
 * brightness grid (`0` = no data, `1..255` = IR brightness) for fast hover inspection on the main thread.
 */
export function buildLumaGrid(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  kind: SatelliteChannel,
  gridSize = LUMA_GRID_SIZE,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(gridSize * gridSize);
  const bg = kind === 'hrv' ? hrvBackground(src) : 0;
  const floor = Math.max(0, bg - 18);
  const span = Math.max(1, 255 - floor);
  for (let r = 0; r < gridSize; r++) {
    const sy = Math.min(height - 1, Math.floor(((r + 0.5) / gridSize) * height));
    for (let c = 0; c < gridSize; c++) {
      const sx = Math.min(width - 1, Math.floor(((c + 0.5) / gridSize) * width));
      const p = (sy * width + sx) * 4;
      const red = src[p];
      const green = src[p + 1];
      const blue = src[p + 2];
      if (red + green + blue === 0) continue;
      const luma = kind === 'hrv' ? Math.max(0, (blue - floor) / span) : (red + green + blue) / (3 * 255);
      out[r * gridSize + c] = Math.max(1, Math.min(255, Math.round(luma * 254 + 1)));
    }
  }
  return out;
}

/** Reads Cloud-Top Temperature (°C), Cloud-Top Height (km) and cloud classification at `(lat, lon)` from a luma grid. */
export function sampleLumaGrid(
  grid: Uint8Array,
  gridSize: number,
  lat: number,
  lon: number,
  b = SATELLITE_BOUNDS,
): SatelliteHoverReading | null {
  if (lat < b.south || lat > b.north || lon < b.west || lon > b.east || grid.length < gridSize * gridSize) return null;
  const r = Math.min(gridSize - 1, Math.max(0, Math.floor(((b.north - lat) / (b.north - b.south)) * gridSize)));
  const c = Math.min(gridSize - 1, Math.max(0, Math.floor(((lon - b.west) / (b.east - b.west)) * gridSize)));
  const raw = grid[r * gridSize + c];
  if (!raw) return null;
  const luma = (raw - 1) / 254;
  const tempC = irLumaToTempC(luma);
  const heightKm = irTempToHeightKm(tempC);
  const { label, color } = classifyCloudTop(tempC);
  return { lat, lon, tempC, heightKm, label, color };
}

/** The overlay's corners for MapLibre: top-left, top-right, bottom-right, bottom-left as [lng, lat]. */
export function satelliteCoordinates(b = SATELLITE_BOUNDS): [[number, number], [number, number], [number, number], [number, number]] {
  return [
    [b.west, b.north],
    [b.east, b.north],
    [b.east, b.south],
    [b.west, b.south],
  ];
}
