/**
 * Pure pixel maths for turning an EUMETView picture into a map overlay.
 *
 * The service returns plain latitude/longitude pictures, but the map is Mercator, where each degree of latitude is
 * taller than the last one going north. So the picture's rows are re-spaced to Mercator before it is placed on the
 * map, and its dark or empty parts are made see-through.
 */
import {
  GeoBounds,
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
  // [tempC, R, G, B, alpha 0..255], warmest first. Windy's infrared (colours measured from its picture): a dark-to-light grey with a faint
  // green tint, then muted teal, khaki, tan, rose-red on the cold tops, deepening to dark red at the coldest.
  [26, 19, 19, 19, 244],
  [15, 36, 38, 36, 244],
  [5, 66, 72, 68, 244],
  [-5, 96, 104, 98, 246],
  [-15, 130, 138, 130, 248],
  [-25, 165, 170, 163, 250],
  [-33, 198, 201, 194, 252],
  [-38, 128, 190, 168, 253],
  [-45, 175, 195, 140, 254],
  [-52, 200, 184, 134, 255],
  [-59, 190, 138, 112, 255],
  [-66, 180, 100, 92, 255],
  [-74, 150, 60, 62, 255],
  [-80, 120, 30, 40, 255],
  [-85, 100, 20, 34, 255],
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

// ── Windy's look for the HRV: low, sunlit cloud is sand, thick shaded cloud slate, cold high cloud white with a blue tint ──
type Rgb = readonly [number, number, number];
/** Cloud that is not cold, by brightness (0..1 of the HRV): the warm ramp. */
const WARM_STOPS: readonly (readonly [number, Rgb])[] = [
  [0.1, [62, 65, 78]],
  [0.3, [100, 96, 92]],
  [0.5, [148, 136, 110]],
  [0.75, [176, 162, 128]],
  [1, [206, 196, 172]],
];
const COLD_LOW: Rgb = [86, 92, 118];
const COLD_HIGH: Rgb = [198, 203, 224];

function rampColor(stops: readonly (readonly [number, Rgb])[], t: number, out: number[]): void {
  const last = stops.length - 1;
  if (t <= stops[0][0]) return void out.splice(0, 3, ...stops[0][1]);
  if (t >= stops[last][0]) return void out.splice(0, 3, ...stops[last][1]);
  let i = 0;
  while (t > stops[i + 1][0]) i++;
  const f = (t - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
  for (let k = 0; k < 3; k++) out[k] = stops[i][1][k] + (stops[i + 1][1][k] - stops[i][1][k]) * f;
}

/** The colour of an HRV pixel in Windy's palette, from its brightness (red and green) and how cold its top is (blue, the infrared). */
export function windyCloudColor(r: number, g: number, b: number, background: number): [number, number, number] {
  const lum = Math.min(1, (r + g) / 510);
  const cold = smoothstep(0.15, 0.6, infraredShare(b, background));
  const warm = [0, 0, 0];
  rampColor(WARM_STOPS, lum, warm);
  // the HRV of thick cloud is nearly saturated: spread the top of its range so the shading of the cloud shows, and only the brightest cores go white
  const k = Math.pow(Math.min(1, Math.max(0, (lum - 0.3) / 0.7)), 2.4);
  return [0, 1, 2].map(i => warm[i] + (COLD_LOW[i] + (COLD_HIGH[i] - COLD_LOW[i]) * k - warm[i]) * cold) as [number, number, number];
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
    if (hasHrv > 0) [r, g, b] = windyCloudColor(r, g, b, background);
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

/** Grows (max) or shrinks (min) a plane by a round window of `radius` pixels; round, so the shapes it leaves are not squares. */
function morph(plane: Float32Array, w: number, h: number, radius: number, grow: boolean): Float32Array {
  // a disc is a stack of rows of different half-widths: one horizontal pass per distinct half-width, then each output row combines rows
  const half: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) half.push(Math.floor(Math.sqrt(radius * radius + 0.5 - dy * dy)));
  const horizontal = new Map<number, Float32Array>();
  for (const k of new Set(half)) {
    const out = new Float32Array(plane.length);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let v = grow ? 0 : 1;
        const x0 = Math.max(0, x - k);
        const x1 = Math.min(w - 1, x + k);
        for (let xx = x0; xx <= x1; xx++) {
          const s = plane[row + xx];
          if (grow ? s > v : s < v) v = s;
        }
        out[row + x] = v;
      }
    }
    horizontal.set(k, out);
  }
  const out = new Float32Array(plane.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let i = 0; i < half.length; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i - radius));
        const s = horizontal.get(half[i])![yy * w + x];
        if (grow ? s > v : s < v) v = s;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** One pixel of a picture half the size per 2 x 2 block of `src` (the mean), for work that does not need the full detail. */
function halve(src: Uint8ClampedArray, width: number, height: number): { data: Uint8ClampedArray; w: number; h: number } {
  const w = width >> 1;
  const h = height >> 1;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (2 * y * width + 2 * x) * 4;
      const q = p + width * 4;
      for (let k = 0; k < 4; k++) data[(y * w + x) * 4 + k] = (src[p + k] + src[p + 4 + k] + src[q + k] + src[q + 4 + k]) >> 2;
    }
  }
  return { data, w, h };
}

/** A plane of `w` x `h` made `width` x `height` by bilinear interpolation. */
function upsample(plane: Float32Array, w: number, h: number, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / height - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / width - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const wx = fx - x0;
      out[y * width + x] = (plane[y0 * w + x0] * (1 - wx) + plane[y0 * w + x1] * wx) * (1 - wy) + (plane[y1 * w + x0] * (1 - wx) + plane[y1 * w + x1] * wx) * wy;
    }
  }
  return out;
}

/**
 * How much of each pixel of an HRV picture is cloud (0 = the clear ground, 1 = cloud), from how far it stands out from the ground around
 * it. `width` x `height` is the picture, which covers `b`.
 */
function cloudKeepAt(src: Uint8ClampedArray, width: number, height: number, b: GeoBounds, spreadRadius: number, closeRadius: number): Float32Array {
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
  // a percentile over a square window leaves square contours: blur them away (about 5 cells) so the cloud edge does not follow squares
  boxBlur(lumGround, gw, gh, 3, 3);
  boxBlur(blueGround, gw, gh, 3, 3);

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
  // thin cloud beside thick cloud belongs to it: strong opacity spreads two pixels (a round reach), where there is some excess at all
  const spread = morph(keep, width, height, spreadRadius, true);
  for (let i = 0; i < keep.length; i++) keep[i] = Math.max(keep[i], 0.85 * spread[i] * smoothstep(3, 9, excess[i]));
  // a small hole in the middle of a cloud (a darker patch of the cloud itself) is not ground: close gaps up to 6 pixels
  const closed = morph(morph(keep, width, height, closeRadius, true), width, height, closeRadius, false);
  for (let i = 0; i < keep.length; i++) keep[i] = Math.max(keep[i], 0.8 * closed[i]);
  boxBlur(keep, width, height, 1, 2); // and the edge of what is left is smooth
  return keep;
}

export function hrvCloudKeep(src: Uint8ClampedArray, width: number, height: number, b: GeoBounds = SATELLITE_BOUNDS): Float32Array {
  // the mask is smooth, so a big picture is judged at half the size (a quarter of the work) and stretched back
  if (width < 1200) return cloudKeepAt(src, width, height, b, 2, 3);
  const half = halve(src, width, height);
  return upsample(cloudKeepAt(half.data, half.w, half.h, b, 1, 2), half.w, half.h, width, height);
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
