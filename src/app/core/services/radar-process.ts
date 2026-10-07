/**
 * Turning one decoded IMD radar picture into the station's intensity field (pure, so it also runs in a web worker).
 *
 * The picture is classified pixel by pixel with the legend's colours, resampled to a 1024 x 1024 grid (about 0.5 km), cleaned
 * of clutter and radial interference spokes, and smoothed into a continuous field the GPU layer draws.
 */
import { GifReader } from 'omggif';
import type { RadarCropConfig, RadarPaletteEntry } from '../domain/models/radar.model';
import { blurSeparable, gaussianKernel, resampleBilinear } from './radar-field';

/** Side of the intensity field a station is resampled to: 1024 pixels, about 0.5 km each. */
export const RADAR_FIELD_SIZE = 1024;

export interface RadarPixelOptions {
  crop?: RadarCropConfig;
  palette?: RadarPaletteEntry[];
  isTransparent: boolean;
  isXBand: boolean;
}

/** Whether the picture still has the layout the station's crop was measured on (IMD swaps in a "maintenance" photo). */
export function layoutMatches(crop: RadarCropConfig | undefined, w: number, h: number): boolean {
  return !crop || (crop.x + crop.w <= w + 2 && crop.y + crop.h <= h + 2);
}

/**
 * Blur applied to the reconstructed intensity, in pixels of the 1024 grid (about 0.5 km each). Light: the GPU layer
 * smooths the intensity itself when it draws, so contours stay crisp at any zoom.
 */
const RADAR_BLUR_SIGMA_PX = 2.6;

// ── Radial interference (spoke) removal ──
// Sun strikes and RF interference paint long, thin wedges that point straight at the radar.
// Real rain is spread across neighbouring azimuths; a spoke is not. Each 0.5° ray's echo fill is
// compared with the rays 3°–6° to either side, and rays that stand out alone are cleared.
const SPOKE_AZIMUTH_BINS = 720;
const SPOKE_MIN_FILL = 0.2;
const SPOKE_FLANK_RATIO = 0.25;
const SPOKE_MIN_RADIUS_PX = 24;
const spokeGeometryCache = new Map<number, { bins: Int16Array; totals: Float64Array }>();

function getSpokeGeometry(size: number): { bins: Int16Array; totals: Float64Array } {
  let geom = spokeGeometryCache.get(size);
  if (geom) return geom;
  const half = size / 2;
  const maxR = half - 2;
  const bins = new Int16Array(size * size).fill(-1);
  const totals = new Float64Array(SPOKE_AZIMUTH_BINS);
  for (let y = 0; y < size; y++) {
    const dy = y - half;
    for (let x = 0; x < size; x++) {
      const dx = x - half;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r < SPOKE_MIN_RADIUS_PX || r > maxR) continue;
      let a = Math.atan2(dy, dx);
      if (a < 0) a += 2 * Math.PI;
      const bin = Math.floor((a / (2 * Math.PI)) * SPOKE_AZIMUTH_BINS) % SPOKE_AZIMUTH_BINS;
      bins[y * size + x] = bin;
      totals[bin]++;
    }
  }
  geom = { bins, totals };
  spokeGeometryCache.set(size, geom);
  return geom;
}

/**
 * Clears radial interference spokes from a square radar field centred on the radar.
 * Returns the number of cleared pixels.
 */
export function removeRadialInterference(grid: Float32Array, size: number): number {
  const { bins, totals } = getSpokeGeometry(size);
  const echo = new Float64Array(SPOKE_AZIMUTH_BINS);
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > 0 && bins[i] >= 0) echo[bins[i]]++;
  }
  const fill = new Float64Array(SPOKE_AZIMUTH_BINS);
  for (let a = 0; a < SPOKE_AZIMUTH_BINS; a++) {
    fill[a] = totals[a] > 0 ? echo[a] / totals[a] : 0;
  }

  const spoke = new Uint8Array(SPOKE_AZIMUTH_BINS);
  let anySpoke = false;
  for (let a = 0; a < SPOKE_AZIMUTH_BINS; a++) {
    if (fill[a] < SPOKE_MIN_FILL) continue;
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

function classifyPalettePixel(r: number, g: number, b: number, palette: RadarPaletteEntry[]): number {
  const tolerance = 6;
  for (const entry of palette) {
    const [pr, pg, pb] = entry.rgb;
    if (Math.abs(r - pr) <= tolerance && Math.abs(g - pg) <= tolerance && Math.abs(b - pb) <= tolerance) {
      // Echoes below ~8 dBZ are clear-air returns / noise rather than precipitation
      if (entry.dbz < 8) return 0.0;
      return Math.max(0.3, (entry.dbz - 12) / 9.6);
    }
  }
  return 0.0;
}

/**
 * The intensity field (1024 x 1024, `Float32Array`) of a decoded picture `rgba` of `w` x `h` pixels. The caller has checked
 * `layoutMatches`.
 */
export function processRadarPixels(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, opts: RadarPixelOptions): Float32Array {
  const { crop, palette } = opts;
  // 1. Full Square Extent Crop Detection (Preserves all corner storm echoes)
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

  // 2. High-Resolution Square Output Canvas (1024x1024 for smooth curved contours at deep zoom)
  const outSize = RADAR_FIELD_SIZE;
  const halfSize = outSize / 2;
  const maxRadius = halfSize - 2; // Strict circular radar sweep boundary limit

  let hasAnyEcho = false;
  const { isXBand, isTransparent } = opts;

  // 3. Classify every source pixel once, at the image's own resolution. Resampling the colour classes (rather than
  // the picture) lets the intensity be interpolated smoothly below, instead of copying stair-stepped blocks.
  const classes = new Float32Array(cropW * cropH);
  for (let sy = 0; sy < cropH; sy++) {
    const py = cropY + sy;
    if (py < 0 || py >= h) continue;
    for (let sx = 0; sx < cropW; sx++) {
      const px = cropX + sx;
      if (px < 0 || px >= w) continue;
      const srcIdx = (py * w + px) * 4;
      classes[sy * cropW + sx] = classifyRainPixel(rgba[srcIdx], rgba[srcIdx + 1], rgba[srcIdx + 2], isTransparent, isXBand, palette);
    }
  }
  const rawGrid = resampleBilinear(classes, cropW, cropH, outSize);

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
        // 1. It forms an extensive contiguous rain area (>= 60 pixels in the 1024x1024 grid, representing ~15 sq km)
        // 2. OR it contains an active convective core (maxVal >= 1.4, i.e. >= 25 dBZ) with at least 15 pixels area
        const isCoherentRain = compCount >= 60 || (maxVal >= 1.4 && compCount >= 15);
        if (!isCoherentRain) {
          for (let i = 0; i < compCount; i++) {
            rawGrid[compIndices[i]] = 0.0;
          }
        }
      }
    }

    removeRadialInterference(rawGrid, outSize);

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
    // 4. Natural continuous-field smoothing: Gaussian blur gives organic curved contours.
    const baseBlur = blurSeparable(rawGrid, outSize, gaussianKernel(RADAR_BLUR_SIGMA_PX));

    // Preserve authentic convective peak intensities (torrential rain and storm cores)
    // by reconstructing the peak excess through a smooth diffusion filter rather than
    // copying stair-stepped raw pixels.
    const peakDiff = new Float32Array(outSize * outSize);
    for (let i = 0; i < rawGrid.length; i++) {
      if (rawGrid[i] > baseBlur[i]) {
        peakDiff[i] = rawGrid[i] - baseBlur[i];
      }
    }
    const smoothPeakDiff = blurSeparable(peakDiff, outSize, gaussianKernel(1.8));

    // - Color mapping with smooth Hermite border feathering (blends seamlessly into terrain)
    for (let y = 0; y < outSize; y++) {
      const dy = y - halfSize;
      const rowOffset = y * outSize;
      for (let x = 0; x < outSize; x++) {
        const dx = x - halfSize;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const dishEdgeDist = maxRadius - dist;
        if (dishEdgeDist <= 0) continue;

        let val = baseBlur[rowOffset + x] + smoothPeakDiff[rowOffset + x] * 1.25;
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
