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
import { fastBlurPlane } from './satellite-enhance';

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
  // [tempC, R, G, B, alpha 0..255], warmest first. Windy's infrared, measured from its picture of the same day: a mid-to-light grey (the
  // ground is not black), then the height of the cold tops in colour: blue, cyan, green, yellow, orange, red, dark red at the coldest.
  // The band edges are set so each colour covers as much of the picture as it does on Windy.
  [26, 93, 93, 93, 244],
  [15, 105, 111, 105, 244],
  [5, 127, 138, 130, 244],
  [-5, 146, 158, 149, 246],
  [-15, 170, 180, 170, 248],
  [-25, 195, 201, 192, 250],
  [-33, 225, 228, 220, 252],
  [-44, 240, 242, 235, 253],
  [-50, 44, 112, 238, 254],
  [-56, 62, 198, 232, 254],
  [-64, 92, 212, 112, 255],
  [-73, 250, 226, 44, 255],
  [-79, 255, 150, 32, 255],
  [-82, 226, 52, 32, 255],
  [-84, 150, 16, 18, 255],
  [-85, 100, 6, 12, 255],
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

// ── Windy's visible picture: dark slate ground, gold low cloud, blue-white cold cloud, opaque, the borders drawn over it ──
type Rgb = readonly [number, number, number];
/**
 * The two ramps of Windy's visible satellite, by the brightness of the picture drawn (0..1), measured on a screenshot of Windy over South
 * India (13:26 IST): the mean colour of its pixels in each band of brightness. The cool ramp is the clear ground (dark slate) and cold
 * cloud (blue-grey to blue-white); the gold ramp is the most golden third of its warm pixels, low sunlit cloud (amber to cream). The few
 * bands where the screenshot's own markers (wind badges, lightning) crept into the means are smoothed.
 */
const COOL_STOPS: readonly (readonly [number, Rgb])[] = [
  [0, [3, 4, 9]],
  [0.05, [12, 13, 15]],
  [0.1, [25, 26, 29]],
  [0.15, [36, 37, 43]],
  [0.2, [52, 54, 61]],
  [0.25, [61, 63, 73]],
  [0.3, [72, 73, 82]],
  [0.35, [79, 84, 97]],
  [0.4, [87, 96, 113]],
  [0.45, [99, 110, 129]],
  [0.5, [118, 122, 142]],
  [0.55, [130, 134, 155]],
  [0.6, [142, 147, 169]],
  [0.65, [154, 160, 182]],
  [0.7, [167, 173, 195]],
  [0.75, [179, 186, 207]],
  [0.8, [193, 200, 217]],
  [0.85, [207, 213, 228]],
  [0.9, [222, 225, 240]],
  [0.95, [239, 240, 251]],
  [1, [249, 254, 255]],
];
const GOLD_STOPS: readonly (readonly [number, Rgb])[] = [
  [0, [6, 5, 4]],
  [0.1, [30, 26, 20]],
  [0.2, [70, 58, 40]],
  [0.3, [100, 84, 60]],
  [0.4, [135, 110, 72]],
  [0.5, [172, 138, 80]],
  [0.55, [184, 149, 95]],
  [0.6, [196, 160, 110]],
  [0.65, [210, 174, 122]],
  [0.7, [225, 187, 130]],
  [0.75, [240, 201, 137]],
  [0.8, [245, 208, 145]],
  [0.85, [246, 221, 172]],
  [0.9, [250, 236, 196]],
  [0.95, [255, 245, 221]],
  [1, [255, 250, 236]],
];

/** Steps per unit of brightness in the ramp tables: every stop above sits on a multiple of 1/20, so a table this fine is exact. */
const RAMP_STEPS = 20;

/** A ramp sampled at every 1/RAMP_STEPS (RGB triples), so a pixel's colour is one lookup and one blend, not a search. */
function rampTable(stops: readonly (readonly [number, Rgb])[]): Float64Array {
  const table = new Float64Array((RAMP_STEPS + 1) * 3);
  const last = stops.length - 1;
  for (let k = 0; k <= RAMP_STEPS; k++) {
    const t = k / RAMP_STEPS;
    let i = 0;
    while (i < last - 1 && t > stops[i + 1][0]) i++;
    const f = Math.min(1, Math.max(0, (t - stops[i][0]) / (stops[i + 1][0] - stops[i][0])));
    for (let c = 0; c < 3; c++) table[k * 3 + c] = stops[i][1][c] + (stops[i + 1][1][c] - stops[i][1][c]) * f;
  }
  return table;
}
const COOL_TABLE = rampTable(COOL_STOPS);
const GOLD_TABLE = rampTable(GOLD_STOPS);

/** Scratch for windyVisibleInto: the colour is left at 0..2 (no allocation: this runs for every pixel of every picture). */
const RAMP_SCRATCH = new Float64Array(3);

/** Clear ground as Windy draws it: its brightness (0-255) for a ground of HRV brightness `ground` (land about 70, sea darker). */
export function groundTone(ground: number): number {
  return 18 + 0.44 * ground;
}
/** Clear land and clear sea as Windy draws them (the darkest of its cloud-free pixels): a neutral, slightly warm slate, and navy. */
const CLEAR_LAND: Rgb = [70, 66, 62];
const CLEAR_SEA: Rgb = [46, 53, 72];
/** How far (0-255) a pixel may stand above the ground in the HRV and still be ground: the land's own variation and the sensor's noise. */
export const GROUND_NOISE = 12;
/** How much brighter than the ground's tone a pixel is drawn for each step it stands above the ground (beyond GROUND_NOISE) in the HRV. */
export const CLOUD_GAIN = 1.6;
/** The brightness (0-255, the HRV's red and green) of cloud thick enough to hide the ground, and how far above the ground it is at least. */
export const OPAQUE_CLOUD_LUM = 215;
const OPAQUE_ABOVE_GROUND = 60;
/** The blur (picture pixels) of the brightness that says how much of a pixel is cloud: about two, so the gold follows whole clouds and does not flicker from pixel to pixel. */
export const HRV_COVER_SMOOTH_SIGMA = 2;

/**
 * The colour of an HRV pixel as Windy draws its visible satellite. Its brightness: clear ground dark (groundTone), cloud brighter by how
 * far it stands above the ground around it (`ground`, see hrvCloudLayers), up to white. Its colour: clear ground a flat slate on land and
 * navy at sea (CLEAR_LAND, CLEAR_SEA), and where there is cloud (from `smoothLum`, the brightness a little
 * blurred, so the colour follows the shape of the cloud and not single pixels) the cool ramp (blue-grey to blue-white) for a cold top and
 * the gold ramp for one that is not (the infrared in the blue channel). The colour is left in RAMP_SCRATCH.
 */
function windyVisibleInto(r: number, g: number, b: number, background: number, ground: number, smoothLum: number): void {
  const lum = (r + g) / 2;
  // only what stands clearly above the ground is cloud: the land's own variation (fields, hills, shadow, the sensor's noise) is not
  // (none up to GROUND_NOISE, ramping back to the full excess by twice that, so real cloud is as bright as without the dead zone)
  const excess = lum - ground;
  const above = excess < GROUND_NOISE ? 0 : excess < 2 * GROUND_NOISE ? 2 * (excess - GROUND_NOISE) : excess;
  const tone = Math.min(255, groundTone(ground) + CLOUD_GAIN * above);
  const opaque = Math.max(ground + OPAQUE_ABOVE_GROUND, OPAQUE_CLOUD_LUM);
  const cloud = Math.min(1, Math.max(0, (smoothLum - ground) / (opaque - ground)));
  const cold = smoothstep(0.15, 0.6, infraredShare(b, background));
  const gold = (1 - cold) * smoothstep(0.1, 0.45, cloud);
  // clear ground: land or sea by how bright the ground is, flat, as Windy draws it (no mottle of the land's own light and shade)
  const land = smoothstep(45, 95, ground);
  const cover = smoothstep(0.08, 0.32, cloud);
  const pos = (tone / 255) * RAMP_STEPS;
  const k = Math.min(RAMP_STEPS - 1, Math.floor(pos));
  const f = pos - k;
  const i = k * 3;
  for (let c = 0; c < 3; c++) {
    const cool = COOL_TABLE[i + c] + (COOL_TABLE[i + 3 + c] - COOL_TABLE[i + c]) * f;
    const warm = GOLD_TABLE[i + c] + (GOLD_TABLE[i + 3 + c] - GOLD_TABLE[i + c]) * f;
    const clear = CLEAR_SEA[c] + (CLEAR_LAND[c] - CLEAR_SEA[c]) * land;
    const cloudy = cool + (warm - cool) * gold;
    RAMP_SCRATCH[c] = clear + (cloudy - clear) * cover;
  }
}

/** windyVisibleInto as a value: [r, g, b]. `smoothLum` defaults to the pixel's own brightness. */
export function windyVisibleColor(r: number, g: number, b: number, background: number, ground: number, smoothLum = (r + g) / 2): [number, number, number] {
  windyVisibleInto(r, g, b, background, ground, smoothLum);
  return [RAMP_SCRATCH[0], RAMP_SCRATCH[1], RAMP_SCRATCH[2]];
}

/** The colour of a cool-ramp brightness (0-255): the no-data patch of the HRV is drawn with it, from the infrared. */
function coolInto(tone: number): void {
  const pos = (Math.min(255, Math.max(0, tone)) / 255) * RAMP_STEPS;
  const k = Math.min(RAMP_STEPS - 1, Math.floor(pos));
  const f = pos - k;
  for (let c = 0; c < 3; c++) RAMP_SCRATCH[c] = COOL_TABLE[k * 3 + c] + (COOL_TABLE[k * 3 + 3 + c] - COOL_TABLE[k * 3 + c]) * f;
}

/**
 * Colour and opacity (0..255) of one pixel; the result is written into `out` at `o`.
 *
 * HRV (by day): Windy's visible picture (see windyVisibleInto), opaque: the ground is part of it; only true black, the empty edge of
 * the picture, is see-through. Where the HRV has no data (a large patch of the north-east, and the night side at dawn and dusk) the
 * service shows only the infrared in the blue channel, a violet patch, so there the infrared is drawn instead in the cool ramp, darker
 * for the warm ground and brighter the colder the cloud.
 *
 * Infrared (by night): the cloud-top colours (see cloudTopColor); the warm ground and sea are see-through.
 *
 * `ground` is the clear-ground brightness around the pixel (see hrvCloudLayers; the pixel's own when it is not known) and `smoothLum` the
 * pixel's brightness a little blurred.
 */
export function shadePixel(
  kind: SatelliteChannel,
  r: number,
  g: number,
  b: number,
  background: number,
  out: Uint8ClampedArray,
  o: number,
  ground = -1,
  smoothLum = (r + g) / 2,
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
    const hrvAlpha = smoothstep(3, 14, Math.max(r, g, b)); // only the empty edge of the picture is see-through
    const ir = infraredShare(b, background);
    if (hasHrv > 0) {
      windyVisibleInto(r, g, b, background, ground >= 0 ? ground : Math.min(hrv, 100), smoothLum);
      r = RAMP_SCRATCH[0];
      g = RAMP_SCRATCH[1];
      b = RAMP_SCRATCH[2];
    }
    if (hasHrv >= 1) {
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
      out[o + 3] = Math.round(255 * hrvAlpha);
      return;
    }
    // where the HRV has no data, the infrared in the cool ramp: the warm ground dark, cold cloud bright
    coolInto(60 + 190 * smoothstep(0.1, 0.9, ir));
    const [fr, fg, fb] = [RAMP_SCRATCH[0], RAMP_SCRATCH[1], RAMP_SCRATCH[2]];
    // premultiplied mix of the HRV pixel (where it has data) and the infrared fill, so the edge of the data has no seam
    const wHrv = hrvAlpha * hasHrv;
    const wFill = 1 - hasHrv;
    const total = wHrv + wFill;
    if (total <= 0) {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      return;
    }
    out[o] = (r * wHrv + fr * wFill) / total;
    out[o + 1] = (g * wHrv + fg * wFill) / total;
    out[o + 2] = (b * wHrv + fb * wFill) / total;
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
function windowPercentile(plane: Int16Array, w: number, h: number, radius: number, pct: number, empty = 60): Float32Array {
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
        out[y * w + x] = empty;
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
  const rows = half.map(k => horizontal.get(k)!); // looked up once, not for every pixel
  const out = new Float32Array(plane.length).fill(grow ? 0 : 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let i = 0; i < rows.length; i++) {
      const src = rows[i];
      const s = Math.min(h - 1, Math.max(0, y + i - radius)) * w;
      // a whole row at a time, so the reads stay in order
      if (grow) for (let x = 0; x < w; x++) out[o + x] = Math.max(out[o + x], src[s + x]);
      else for (let x = 0; x < w; x++) out[o + x] = Math.min(out[o + x], src[s + x]);
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
function cloudKeepAt(
  src: Uint8ClampedArray, width: number, height: number, b: GeoBounds, spreadRadius: number, closeRadius: number, withKeep = true,
): { keep: Float32Array; ground: Float32Array } {
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
  // The ground to draw (see windyVisibleInto) is measured for land and sea apart: near a coast the window holds both, and its low
  // percentile is the dark sea, so clear land within a window of the coast would stand out as cloud (a band of false cloud along every
  // coast). Sea is the cells far darker than most of the picture; each kind's ground is the low percentile of its own cells, and a pixel
  // takes the ground of the kind it is nearer (below).
  const seaMax = 0.55 * lumCap;
  const landCells = lumPlane.map(v => (v >= seaMax ? v : -1));
  const seaCells = lumPlane.map(v => (v >= 0 && v < seaMax ? v : -1));
  const landGround = windowPercentile(landCells, gw, gh, radius, GROUND_PERCENTILE, -1);
  const seaGround = windowPercentile(seaCells, gw, gh, radius, GROUND_PERCENTILE, -1);
  for (let i = 0; i < landGround.length; i++) {
    landGround[i] = landGround[i] < 0 ? lumGround[i] : Math.min(landGround[i], lumCap);
    seaGround[i] = seaGround[i] < 0 ? lumGround[i] : seaGround[i];
  }
  // a percentile over a square window leaves square contours: blur them away (about 5 cells) so the cloud edge does not follow squares
  boxBlur(lumGround, gw, gh, 3, 3);
  boxBlur(blueGround, gw, gh, 3, 3);
  boxBlur(landGround, gw, gh, 3, 3);
  boxBlur(seaGround, gw, gh, 3, 3);

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
  const ground = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const f = Math.min(gh - 1, Math.max(0, (y + 0.5) / stride - 0.5));
    const r0 = Math.floor(f) * gw;
    const r1 = Math.min(gh - 1, Math.floor(f) + 1) * gw;
    const wy = f - Math.floor(f);
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (src[p] + src[p + 1] + src[p + 2] < 12) continue;
      // the ground under the pixel, bilinear on the coarse grid (inlined: this runs for every pixel)
      const a0 = r0 + cx0[x];
      const a1 = r0 + cx1[x];
      const b0 = r1 + cx0[x];
      const b1 = r1 + cx1[x];
      const wx = cwx[x];
      const lum = (lumGround[a0] * (1 - wx) + lumGround[a1] * wx) * (1 - wy) + (lumGround[b0] * (1 - wx) + lumGround[b1] * wx) * wy;
      const blue = (blueGround[a0] * (1 - wx) + blueGround[a1] * wx) * (1 - wy) + (blueGround[b0] * (1 - wx) + blueGround[b1] * wx) * wy;
      // the ground drawn: the land's or the sea's, whichever the pixel is nearer (a pixel as bright as the land is land or cloud over it)
      const gl = (landGround[a0] * (1 - wx) + landGround[a1] * wx) * (1 - wy) + (landGround[b0] * (1 - wx) + landGround[b1] * wx) * wy;
      const gs = (seaGround[a0] * (1 - wx) + seaGround[a1] * wx) * (1 - wy) + (seaGround[b0] * (1 - wx) + seaGround[b1] * wx) * wy;
      const mid = (gl + gs) / 2;
      ground[y * width + x] = gs + (gl - gs) * smoothstep(mid - 8, mid + 8, (src[p] + src[p + 1]) / 2);
      if (!withKeep) continue;
      const e = Math.max((src[p] + src[p + 1]) / 2 - lum, 0.8 * (src[p + 2] - blue));
      excess[y * width + x] = e;
      keep[y * width + x] = smoothstep(KEEP_FROM, KEEP_FULL, e);
    }
  }
  if (!withKeep) return { keep, ground };
  // thin cloud beside thick cloud belongs to it: strong opacity spreads two pixels (a round reach), where there is some excess at all
  const spread = morph(keep, width, height, spreadRadius, true);
  for (let i = 0; i < keep.length; i++) keep[i] = Math.max(keep[i], 0.85 * spread[i] * smoothstep(3, 9, excess[i]));
  // a small hole in the middle of a cloud (a darker patch of the cloud itself) is not ground: close gaps up to 6 pixels
  const closed = morph(morph(keep, width, height, closeRadius, true), width, height, closeRadius, false);
  for (let i = 0; i < keep.length; i++) keep[i] = Math.max(keep[i], 0.8 * closed[i]);
  boxBlur(keep, width, height, 1, 2); // and the edge of what is left is smooth
  return { keep, ground };
}

/**
 * How much of each pixel of an HRV picture is cloud (`keep`, see cloudKeepAt) and the brightness of the clear ground around it (`ground`,
 * the HRV's red and green, 0-255; 0 on the empty edge). `withKeep` false skips the cloud mask (all zero), which only the ground is not.
 */
export function hrvCloudLayers(
  src: Uint8ClampedArray, width: number, height: number, b: GeoBounds = SATELLITE_BOUNDS, withKeep = true,
): { keep: Float32Array; ground: Float32Array } {
  // both are smooth, so a big picture is judged at half the size (a quarter of the work) and stretched back
  if (width < 1200) return cloudKeepAt(src, width, height, b, 2, 3, withKeep);
  const half = halve(src, width, height);
  const layers = cloudKeepAt(half.data, half.w, half.h, b, 1, 2, withKeep);
  return { keep: upsample(layers.keep, half.w, half.h, width, height), ground: upsample(layers.ground, half.w, half.h, width, height) };
}

export function hrvCloudKeep(src: Uint8ClampedArray, width: number, height: number, b: GeoBounds = SATELLITE_BOUNDS): Float32Array {
  return hrvCloudLayers(src, width, height, b).keep;
}

/**
 * Re-space the rows of an RGBA picture to Mercator (linear blend between the two nearest source rows) and set colour and
 * opacity (see shadePixel). `src` is `width` x `srcHeight`; the result is `width` x `outHeight`.
 * When `twilightIr` and `timeMs` are provided for an HRV frame near sunrise/sunset, pixels on the dark side of the solar
 * terminator smoothly transition to the infrared picture instead of going black.
 * An HRV picture is drawn as Windy's visible satellite (see windyVisibleInto).
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
  const ground = kind === 'hrv' ? hrvCloudLayers(src, width, srcHeight, b, false).ground : null;
  // the brightness a little blurred (about one pixel), for how much of each pixel is cloud: see windyVisibleInto
  let smooth: Float32Array | null = null;
  if (ground) {
    smooth = new Float32Array(width * srcHeight);
    for (let i = 0, p = 0; i < smooth.length; i++, p += 4) smooth[i] = (src[p] + src[p + 1]) / 2;
    fastBlurPlane(smooth, width, srcHeight, HRV_COVER_SMOOTH_SIGMA);
  }
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
        ground ? ground[y0 * width + x] * (1 - w) + ground[y1 * width + x] * w : -1,
        smooth ? smooth[y0 * width + x] * (1 - w) + smooth[y1 * width + x] * w : undefined,
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
