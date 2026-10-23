/**
 * Turning one decoded IMD radar picture into the station's intensity field (pure, so it also runs in a web worker).
 *
 * The picture is classified pixel by pixel with the legend's colours, resampled to a 1024 x 1024 grid (about 0.5 km), cleaned
 * of clutter and radial interference spokes, and smoothed into a continuous field the GPU layer draws.
 */
import { GifReader } from 'omggif';
import type { RadarCropConfig, RadarPaletteEntry } from '../domain/models/radar.model';
import { blurSeparable, gaussianKernel, keepStrongPixels, resampleBilinear } from './radar-field';

/** Side of the intensity field a station is resampled to: 1024 pixels, about 0.5 km each. */
export const RADAR_FIELD_SIZE = 1024;

export interface RadarPixelOptions {
  crop?: RadarCropConfig;
  palette?: RadarPaletteEntry[];
  isTransparent: boolean;
  isXBand: boolean;
  /** Keep the whole square of the picture (the PPI is shown as the square it is), not only the circle of the dish. */
  square?: boolean;
}

/** Whether the picture still has the layout the station's crop was measured on (IMD swaps in a "maintenance" photo). */
export function layoutMatches(crop: RadarCropConfig | undefined, w: number, h: number): boolean {
  return !crop || (crop.x + crop.w <= w + 2 && crop.y + crop.h <= h + 2);
}

/**
 * Whether the picture is a radar sweep at all: a real one always carries its colour legend, so most of the station's palette colours are in
 * it; IMD's "RADAR UNDER MAINTENANCE" photo of Karaikal (same 880 x 720 size as a sweep, its file's time refreshed like a live one) has 1 of
 * the 19 legend steps, real sweeps 15 to 19 of theirs (measured 23 Oct). Read on every third pixel of every third row.
 */
export function looksLikeRadar(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, palette: readonly RadarPaletteEntry[] | undefined): boolean {
  if (!palette || palette.length === 0) return true;
  const seen = new Uint16Array(palette.length);
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const o = (y * w + x) * 4;
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      for (let i = 0; i < palette.length; i++) {
        const c = palette[i].rgb;
        // within the entry's own tolerance: a gradient legend sampled every few rows of its bar has neighbours a few levels apart
        // every entry the pixel is close to (near-identical neighbours of a gradient legend all count)
        if (Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]) <= Math.max(9, 2 * (palette[i].tol ?? 0))) seen[i]++;
      }
    }
  }
  let present = 0;
  for (const n of seen) if (n >= 2) present++;
  return present >= palette.length * 0.4;
}

/**
 * Blur applied to the reconstructed intensity, in pixels of the 1024 grid (about 0.5 km each). Light: the GPU layer
 * smooths the intensity itself when it draws, so contours stay crisp at any zoom.
 */
const RADAR_BLUR_SIGMA_PX = 2.6;
/** Picture pixels at or above this intensity (31 dBZ) keep their own value when the picture is stretched to the working grid. */
const STRONG_PIXEL_MIN = 2.0;

// ── Radial interference (spoke) removal ──
// Sun strikes and RF interference paint long, thin wedges that point straight at the radar and run all the way out.
// Real rain is spread across neighbouring azimuths, and even a band that points at the radar covers only part of the range.
// Each 0.5° ray's echo fill is compared with the rays 3°–6° to either side, and rays that stand out alone are cleared,
// but only when the echo runs all the way out to the edge of the range and back through the middle or the inner part: a real rain band
// pointing at the radar is narrow in azimuth too, and would otherwise be taken for a spoke and deleted.
const SPOKE_AZIMUTH_BINS = 720;
const SPOKE_MIN_FILL = 0.2;
const SPOKE_FLANK_RATIO = 0.25;
const SPOKE_MIN_RADIUS_PX = 24;
const SPOKE_THIRDS = 3;
const SPOKE_MIN_THIRD_FILL = 0.3;
const SPOKE_MIN_OUTER_FILL = 0.6;
interface SpokeGeometry { bins: Int16Array; thirds: Uint8Array; totals: Float64Array; thirdTotals: Float64Array }
const spokeGeometryCache = new Map<number, SpokeGeometry>();

function getSpokeGeometry(size: number): SpokeGeometry {
  let geom = spokeGeometryCache.get(size);
  if (geom) return geom;
  const half = size / 2;
  const maxR = half - 2;
  const bins = new Int16Array(size * size).fill(-1);
  const thirds = new Uint8Array(size * size);
  const totals = new Float64Array(SPOKE_AZIMUTH_BINS);
  const thirdTotals = new Float64Array(SPOKE_AZIMUTH_BINS * SPOKE_THIRDS);
  for (let y = 0; y < size; y++) {
    const dy = y - half;
    for (let x = 0; x < size; x++) {
      const dx = x - half;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r < SPOKE_MIN_RADIUS_PX || r > maxR) continue;
      let a = Math.atan2(dy, dx);
      if (a < 0) a += 2 * Math.PI;
      const bin = Math.floor((a / (2 * Math.PI)) * SPOKE_AZIMUTH_BINS) % SPOKE_AZIMUTH_BINS;
      const third = Math.min(SPOKE_THIRDS - 1, Math.floor(((r - SPOKE_MIN_RADIUS_PX) / (maxR - SPOKE_MIN_RADIUS_PX)) * SPOKE_THIRDS));
      bins[y * size + x] = bin;
      thirds[y * size + x] = third;
      totals[bin]++;
      thirdTotals[bin * SPOKE_THIRDS + third]++;
    }
  }
  geom = { bins, thirds, totals, thirdTotals };
  spokeGeometryCache.set(size, geom);
  return geom;
}

/**
 * Clears radial interference spokes from a square radar field centred on the radar.
 * Returns the number of cleared pixels.
 */
export function removeRadialInterference(grid: Float32Array, size: number): number {
  const { bins, thirds, totals, thirdTotals } = getSpokeGeometry(size);
  const echo = new Float64Array(SPOKE_AZIMUTH_BINS);
  const echoThird = new Float64Array(SPOKE_AZIMUTH_BINS * SPOKE_THIRDS);
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > 0 && bins[i] >= 0) {
      echo[bins[i]]++;
      echoThird[bins[i] * SPOKE_THIRDS + thirds[i]]++;
    }
  }
  const fill = new Float64Array(SPOKE_AZIMUTH_BINS);
  for (let a = 0; a < SPOKE_AZIMUTH_BINS; a++) {
    fill[a] = totals[a] > 0 ? echo[a] / totals[a] : 0;
  }

  const spoke = new Uint8Array(SPOKE_AZIMUTH_BINS);
  let anySpoke = false;
  for (let a = 0; a < SPOKE_AZIMUTH_BINS; a++) {
    if (fill[a] < SPOKE_MIN_FILL) continue;
    const thirdFill = (t: number) => {
      const n = thirdTotals[a * SPOKE_THIRDS + t];
      return n > 0 ? echoThird[a * SPOKE_THIRDS + t] / n : 0;
    };
    // a spoke runs out to the edge of the range (the outer third is nearly solid) and back through the middle or the inner part; a rain band
    // that points at the radar ends somewhere inside the range
    if (thirdFill(SPOKE_THIRDS - 1) < SPOKE_MIN_OUTER_FILL || Math.max(thirdFill(0), thirdFill(1)) < SPOKE_MIN_THIRD_FILL) continue;
    let flankSum = 0;
    let flankCount = 0;
    for (let k = 6; k <= 12; k++) {
      flankSum += fill[(a + k) % SPOKE_AZIMUTH_BINS] + fill[(a - k + SPOKE_AZIMUTH_BINS) % SPOKE_AZIMUTH_BINS];
      flankCount += 2;
    }
    if (flankSum / flankCount <= SPOKE_FLANK_RATIO * fill[a]) {
      // Widen by 1° each side to catch the wedge's tapered edges
      for (let k = -2; k <= 2; k++) spoke[(a + k + SPOKE_AZIMUTH_BINS) % SPOKE_AZIMUTH_BINS] = 1;
      anySpoke = true;
    }
  }
  if (!anySpoke) return 0;

  let removed = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > 0 && bins[i] >= 0 && spoke[bins[i]] === 1) {
      grid[i] = 0;
      removed++;
    }
  }
  return removed;
}

export function classifyRainPixel(
  r: number,
  g: number,
  b: number,
  isTransparent: boolean,
  isXBand = false,
  palette?: RadarPaletteEntry[]
): number {
  if (!isTransparent) return 1.0;
  if (palette) return classifyPalettePixel(r, g, b, palette);

  const maxRGB = Math.max(r, g, b);
  const minRGB = Math.min(r, g, b);
  const diff = maxRGB - minRGB;

  // 1. Black/Dark borders, grids, text, noise
  if (maxRGB <= 45) return 0.0;

  // 2. Pure grayscale / white paper canvas / monochromatic grid lines (diff <= 8)
  // Rejects pure white [255,255,255] (diff=0), grey sea [211,211,211], range rings [243,243,242] (diff=1)
  if (diff <= 8) return 0.0;

  // 3. Rejects pure green administrative district boundaries & state borders (Chennai DWR)
  // IMD draws district lines in pure green rgb(0, 255, 0) / rgb(0, 204, 0)
  if (r <= 35 && g >= 160 && b <= 60) return 0.0;

  // 4. Sea & Grayscale features (diff <= 25, e.g. grey sea background 191,191,191 and 134,134,134)
  if (diff <= 25) return 0.0;

  // 5. Chennai Sea & Land Background:
  // In Chennai DWR, IMD colors the Bay of Bengal sea in cyan/blue tones where b >= 140 and r >= 65
  // [102, 204, 255], [153, 204, 255], [102, 153, 255], [102, 153, 204], [153, 153, 255]
  // Authentic IMD blue/cyan rain echoes always have low red (r <= 50).
  if (b >= 140 && r >= 65) return 0.0;

  // 6. Mountain terrain / elevation relief (Western Ghats warm tan/beige/khaki)
  // Topographic shading has warm tan/brown tints with high red/green and low-medium blue
  if (r >= 160 && g >= 140 && b >= 90 && r >= b) return 0.0;

  // 7. Purple (Severe storm core / Hail > 55 dBZ)
  if (r >= 180 && b >= 140 && g <= 100) return 5.2;

  // 8. Red (Torrential Rain 48 - 55 dBZ)
  // Covers Karaikal (255,0,0), Chennai (204,0,0), (153,0,0), (255,51,0), Kochi (250,2,2), (231,13,7), (211,21,3)
  if ((r >= 180 && g <= 80 && b <= 80) || (r >= 150 && g <= 50 && b <= 50)) return 4.4;

  // 9. Orange & Red-Orange (40 - 48 dBZ)
  // Covers Karaikal (255,134,0), (255,97,0), Chennai (255,102,0), (255,153,0), Kochi (250,148,7), (245,147,14), (231,165,2), (234,165,12), (218,170,4)
  if (r >= 210 && b <= 50 && g <= 180) {
    return g <= 155 ? 3.8 : 3.4;
  }

  // 10. Yellow (34 - 40 dBZ)
  // Covers Karaikal (255,236,68), Chennai (255,204,0), (255,255,0), Kochi (244,242,79), (251,248,23), (253,253,3)
  if (r >= 210 && g >= 190 && b <= 90) return 3.0;

  // 11. Green Rain (S-Band / PPI / SRI)
  if (!isXBand && g >= 165 && r <= 50 && b <= 120) return 2.0;

  // 12. Cyan / Sky Blue Rain Echoes -> Light Blue (18 - 26 dBZ)
  if (b >= 180 && g >= 120 && r <= 70) return 1.4;

  // 13. Deep Blue / Royal Blue (14 - 18 dBZ)
  if (b >= 150 && r <= 50 && g <= 120) return 1.0;

  // 14. Dark Purple / Indigo (Light Echo 10 - 14 dBZ)
  if (b >= 120 && r <= 70 && g <= 50) return 0.7;

  // Reject all remaining terrain, elevation DEM tints, lake/coast borders
  return 0.0;
}

/** The legend swatch nearest to a colour (every channel within the swatch's tolerance), as an intensity, or null when it is none of them. */
function matchPalette(r: number, g: number, b: number, palette: RadarPaletteEntry[]): { value: number; context: boolean } | null {
  let best: RadarPaletteEntry | null = null;
  let bestDistance = Infinity;
  for (const entry of palette) {
    const tolerance = entry.tol ?? 6;
    const dr = Math.abs(r - entry.rgb[0]);
    const dg = Math.abs(g - entry.rgb[1]);
    const db = Math.abs(b - entry.rgb[2]);
    if (dr > tolerance || dg > tolerance || db > tolerance) continue;
    if (dr + dg + db < bestDistance) {
      bestDistance = dr + dg + db;
      best = entry;
    }
  }
  // Echoes below ~8 dBZ are clear-air returns / noise rather than precipitation
  if (!best || best.dbz < 8) return null;
  return { value: Math.max(0.3, (best.dbz - 12) / 9.6), context: !!best.context };
}

/** The intensity of a colour in a picture with an exact legend; a swatch the basemap also uses (see RadarPaletteEntry.context) needs its neighbours, so alone it is 0. */
function classifyPalettePixel(r: number, g: number, b: number, palette: RadarPaletteEntry[]): number {
  const hit = matchPalette(r, g, b, palette);
  return hit && !hit.context ? hit.value : 0.0;
}

/** A patch of basemap-like colours counts as rain when at least this share of the pixels around it is rain. */
const CORE_RAIN_BORDER = 0.5;
/** ...and a patch this large (picture pixels) must be almost surrounded by rain: a stretch of sea or relief is bordered by the map. */
const CORE_LARGE_PATCH = 1500;
const CORE_LARGE_RAIN_BORDER = 0.75;

/**
 * The swatches the basemap also uses (white, cream, pale yellow, light blue: the strong core of a cell, but also labels, relief and sea) are
 * judged as connected patches, not pixel by pixel: a patch is rain when most of the pixels around it are rain of the other colours. A core is
 * a patch of white and yellow inside the blue of its cell, so all of it is kept (judging each pixel by its own neighbours kept only the rim
 * and lost 80% of the 40 dBZ+ pixels); a white label, a hill or the sea is bordered by the map and stays out. `classes` holds the sure
 * echoes; `candidates` are the pixels of those swatches with the intensity they would have.
 */
function keepCoresInRain(classes: Float32Array, w: number, h: number, all: readonly { index: number; value: number }[]): void {
  // A swatch that covers a large part of the picture is the basemap itself (Chennai draws its sea in the light blue of 33.75 dBZ): it would
  // join every coastal core to the whole sea. Its pixels are judged one by one (rain where at least 3 of the 8 around are rain), and the
  // other swatches as patches.
  const count = new Map<number, number>();
  for (const c of all) count.set(c.value, (count.get(c.value) ?? 0) + 1);
  const basemapLike = new Set([...count].filter(([, n]) => n >= CORE_LARGE_PATCH * 4).map(([v]) => v));
  const candidates = basemapLike.size > 0 ? all.filter(c => !basemapLike.has(c.value)) : all;
  if (basemapLike.size > 0) {
    const sure = classes.slice();
    for (const c of all) {
      if (!basemapLike.has(c.value)) continue;
      const x = c.index % w;
      const y = (c.index - x) / w;
      let around = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if ((dx !== 0 || dy !== 0) && nx >= 0 && ny >= 0 && nx < w && ny < h && sure[ny * w + nx] > 0) around++;
        }
      }
      if (around >= 3) classes[c.index] = c.value;
    }
  }
  const value = new Float32Array(w * h);
  for (const c of candidates) value[c.index] = c.value;
  // IMD draws its district lines, coastline and grid over the rain: a pixel of a one-pixel line inside rain has rain right next to it, so
  // around a patch "rain" is a pixel that is rain or touches rain (a line through a cell does not make its core look like map)
  const rainNear = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (classes[y * w + x] <= 0) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < w) rainNear[ny * w + nx] = 1;
        }
      }
    }
  }
  const seen = new Uint8Array(w * h);
  const counted = new Int32Array(w * h).fill(-1); // the patch an outside pixel was last counted for (each is counted once per patch)
  const stack: number[] = [];
  const members: number[] = [];
  let patch = 0;
  for (const c of candidates) {
    if (seen[c.index]) continue;
    patch++;
    members.length = 0;
    stack.push(c.index);
    seen[c.index] = 1;
    let border = 0;
    let rainBorder = 0;
    while (stack.length > 0) {
      const i = stack.pop()!;
      members.push(i);
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
            border++; // the edge of the picture counts as map
            continue;
          }
          const n = ny * w + nx;
          if (value[n] > 0) {
            if (!seen[n]) {
              seen[n] = 1;
              stack.push(n);
            }
          } else if (counted[n] !== patch) {
            counted[n] = patch;
            border++;
            if (rainNear[n]) rainBorder++;
          }
        }
      }
    }
    const share = border > 0 ? rainBorder / border : 0;
    const needed = members.length >= CORE_LARGE_PATCH ? CORE_LARGE_RAIN_BORDER : CORE_RAIN_BORDER;
    if (share >= needed) for (const i of members) classes[i] = value[i];
  }
}

/**
 * The picture's own intensity, one class per pixel of its map panel (0 where there is no echo): the legend's colours read as intensity.
 * `classes` is `crop.w` x `crop.h`, row 0 at the north edge.
 */
export function classifyRadarPicture(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, opts: RadarPixelOptions): { classes: Float32Array; crop: { x: number; y: number; w: number; h: number } } {
  const { crop, palette } = opts;
  // Full Square Extent Crop Detection (Preserves all corner storm echoes)
  let cropX = 0;
  let cropY = 0;
  let cropW = w;
  let cropH = h;

  if (crop) {
    cropX = crop.x;
    cropY = crop.y;
    cropW = crop.w;
    cropH = crop.h;
  } else if (w > h) {
    cropX = 0;
    cropY = 0;
    cropW = h;
    cropH = h;
  } else {
    cropX = 0;
    cropY = 0;
    cropW = w;
    cropH = h;
  }

  const { isXBand, isTransparent } = opts;

  // Classify every source pixel once, at the image's own resolution. Resampling the colour classes (rather than
  // the picture) lets the intensity be interpolated smoothly below, instead of copying stair-stepped blocks.
  const classes = new Float32Array(cropW * cropH);
  const colourHits = new Map<number, { value: number; context: boolean } | null>();   // a GIF has at most 256 colours: each is matched once
  const needNeighbours: { index: number; value: number }[] = [];
  for (let sy = 0; sy < cropH; sy++) {
    const py = cropY + sy;
    if (py < 0 || py >= h) continue;
    for (let sx = 0; sx < cropW; sx++) {
      const px = cropX + sx;
      if (px < 0 || px >= w) continue;
      const srcIdx = (py * w + px) * 4;
      const r = rgba[srcIdx];
      const g = rgba[srcIdx + 1];
      const b = rgba[srcIdx + 2];
      if (palette && isTransparent) {
        const key = (r << 16) | (g << 8) | b;
        let hit = colourHits.get(key);
        if (hit === undefined) {
          hit = matchPalette(r, g, b, palette);
          colourHits.set(key, hit);
        }
        if (hit && !hit.context) classes[sy * cropW + sx] = hit.value;
        else if (hit) needNeighbours.push({ index: sy * cropW + sx, value: hit.value });
      } else {
        classes[sy * cropW + sx] = classifyRainPixel(r, g, b, isTransparent, isXBand, palette);
      }
    }
  }
  if (needNeighbours.length > 0) keepCoresInRain(classes, cropW, cropH, needNeighbours);
  return { classes, crop: { x: cropX, y: cropY, w: cropW, h: cropH } };
}

/**
 * The intensity field (1024 x 1024, `Float32Array`) of a decoded picture `rgba` of `w` x `h` pixels. The caller has checked
 * `layoutMatches`.
 */
export function processRadarPixels(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, opts: RadarPixelOptions): Float32Array {
  const { classes, crop: { w: cropW, h: cropH } } = classifyRadarPicture(rgba, w, h, opts);
  const { isTransparent } = opts;
  const cropX = opts.crop ? opts.crop.x : 0;
  const cropY = opts.crop ? opts.crop.y : 0;
  // High-Resolution Square Output Canvas (1024x1024 for smooth curved contours at deep zoom)
  const outSize = RADAR_FIELD_SIZE;
  const halfSize = outSize / 2;
  const square = opts.square === true;
  // Strict circular radar sweep boundary limit; a square picture reaches past the corners of the circle
  const maxRadius = square ? halfSize * Math.SQRT2 + 16 : halfSize - 2;
  const squareEdge = (v: number) => Math.min(v, outSize - 1 - v);

  let hasAnyEcho = false;

  const rawGrid = resampleBilinear(classes, cropW, cropH, outSize);
  keepStrongPixels(rawGrid, classes, cropW, cropH, outSize, STRONG_PIXEL_MIN); // the hot cores keep the strength the radar measured

  // Circular dish mask: completely clip anything outside the radar sweep circle
  for (let outY = 0; outY < outSize; outY++) {
    const dy = outY - halfSize;
    const rowOffset = outY * outSize;
    for (let outX = 0; outX < outSize; outX++) {
      const dx = outX - halfSize;
      if (Math.sqrt(dx * dx + dy * dy) > maxRadius) rawGrid[rowOffset + outX] = 0;
      else if (rawGrid[rowOffset + outX] > 0) hasAnyEcho = true;
    }
  }

  const finalField = new Float32Array(outSize * outSize);

  if (isTransparent && hasAnyEcho) {
    // 3.5. Meteorological Spatial Coherence & Clutter Suppression Filter:
    // Meteorological rain cells form spatially coherent 2D precipitation clouds.
    // High-gain receiver noise, clear-air boundary layer backscatter, sea clutter, and
    // radar transmitter artifacts produce isolated 1-to-4 pixel specks (such as Chennai S-Band's
    // concentric ring clutter at 150-250km).
    // No speck filter any more (the user wants every echo the radar shows, small ones included): a single picture pixel is kept.
    const minArea = 1;
    const minStrongArea = 1;
    const visited = new Uint8Array(outSize * outSize);
    const queue = new Int32Array(outSize * outSize);
    const compIndices = new Int32Array(outSize * outSize);

    for (let y = 0; y < outSize; y++) {
      const rowOffset = y * outSize;
      for (let x = 0; x < outSize; x++) {
        const startIdx = rowOffset + x;
        if (rawGrid[startIdx] <= 0 || visited[startIdx] === 1) continue;

        let head = 0;
        let tail = 0;
        let compCount = 0;
        let maxVal = 0.0;

        queue[tail++] = startIdx;
        visited[startIdx] = 1;

        while (head < tail) {
          const curr = queue[head++];
          compIndices[compCount++] = curr;
          const v = rawGrid[curr];
          if (v > maxVal) maxVal = v;

          const cy = Math.floor(curr / outSize);
          const cx = curr % outSize;

          for (let dy = -1; dy <= 1; dy++) {
            const ny = cy + dy;
            if (ny < 0 || ny >= outSize) continue;
            const nRow = ny * outSize;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx;
              if (nx < 0 || nx >= outSize) continue;
              const nIdx = nRow + nx;
              if (rawGrid[nIdx] > 0 && visited[nIdx] === 0) {
                visited[nIdx] = 1;
                queue[tail++] = nIdx;
              }
            }
          }
        }

        // Meteorological Spatial Coherence Rules:
        // A detected echo is considered genuine precipitation only if:
        // 1. It covers a few of the picture's own pixels (about 3 or more, which is what a lone speck of noise does not)
        // 2. OR it contains an active convective core (maxVal >= 1.4, i.e. >= 25 dBZ) at least 2 pixels wide
        // The areas are counted on the 1024 grid, so they are scaled by how many grid pixels one picture pixel covers: a smaller
        // radar picture (Chennai, 1 km a pixel) and a larger one (Pallikaranai) then keep the same small cells.
        const isCoherentRain = compCount >= minArea || (maxVal >= 1.4 && compCount >= minStrongArea);
        if (!isCoherentRain) {
          for (let i = 0; i < compCount; i++) {
            rawGrid[compIndices[i]] = 0.0;
          }
        }
      }
    }

    // Nothing is filtered out any more: every echo the radar shows is kept (removeRadialInterference is still exported but not applied).

    // Re-evaluate hasAnyEcho after clutter filtering
    hasAnyEcho = false;
    for (let i = 0; i < rawGrid.length; i++) {
      if (rawGrid[i] > 0) {
        hasAnyEcho = true;
        break;
      }
    }
  }

  if (isTransparent && hasAnyEcho) {
    // 4. Natural continuous-field smoothing: a Gaussian blur gives organic curved contours at the edges of an echo.
    const baseBlur = blurSeparable(rawGrid, outSize, gaussianKernel(RADAR_BLUR_SIGMA_PX));

    // The intensity itself is never turned down: `rawGrid` is the picture's own intensity, smoothly interpolated (it passes through the
    // value of every picture pixel), and the blur only adds a soft halo around it. A blur alone, or a blur with a re-built peak, takes a cell
    // of one or two picture pixels down to a fraction of what the radar measured, so a 40 dBZ core came out as 25.
    // - Color mapping with smooth Hermite border feathering (blends seamlessly into terrain)
    for (let y = 0; y < outSize; y++) {
      const dy = y - halfSize;
      const rowOffset = y * outSize;
      for (let x = 0; x < outSize; x++) {
        const dx = x - halfSize;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const dishEdgeDist = square ? squareEdge(x) < squareEdge(y) ? squareEdge(x) + 1 : squareEdge(y) + 1 : maxRadius - dist;
        if (dishEdgeDist <= 0) continue;

        let val = Math.max(baseBlur[rowOffset + x], rawGrid[rowOffset + x]);
        if (val > 5.5) val = 5.5;

        if (dishEdgeDist < 8) {
          val *= Math.max(0, dishEdgeDist / 8);
        }

        finalField[rowOffset + x] = val;
      }
    }
  } else if (!isTransparent) {
    // Raw Mode: copy raw pixels strictly within circular dish
    for (let y = 0; y < outSize; y++) {
      const dy = y - halfSize;
      const rowOffset = y * outSize;
      const normY = y / (outSize - 1);
      const srcY = Math.round(cropY + normY * (cropH - 1));

      for (let x = 0; x < outSize; x++) {
        const dx = x - halfSize;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > maxRadius) continue;

        const normX = x / (outSize - 1);
        const srcX = Math.round(cropX + normX * (cropW - 1));
        if (srcX < 0 || srcX >= w || srcY < 0 || srcY >= h) continue;

        finalField[rowOffset + x] = 1.0;
      }
    }
  }

  return finalField;
}

/** The last frame of a GIF as RGBA, or null when it cannot be decoded. */
export function decodeLastGifFrame(bytes: Uint8Array): { rgba: Uint8Array; w: number; h: number } | null {
  try {
    const reader = new GifReader(bytes);
    const w = reader.width;
    const h = reader.height;
    const rgba = new Uint8Array(w * h * 4);
    reader.decodeAndBlitFrameRGBA(Math.max(0, reader.numFrames() - 1), rgba);
    return { rgba, w, h };
  } catch {
    return null;
  }
}
