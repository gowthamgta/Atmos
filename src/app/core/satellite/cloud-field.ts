/**
 * The clouds of a satellite picture in three dimensions, for the 3D view (rendering/cloud-volume.layer.ts): for each cell of a coarse
 * Mercator grid over the picture, how much of it is cloud, the height of the cloud's top and of its base, and how thick it is to light.
 *
 * - Top: from the cloud-top temperature of the infrared (the HRV picture carries it in its blue channel), through the same tropical lapse
 *   rate as the hover readout (irLumaToTempC, irTempToHeightKm). A cell partly covered reads warmer than its cloud, so the cell's top is
 *   taken from its coldest cloudy pixels rather than its mean.
 * - Optical thickness (by day): from the visible brightness, which grows with it as R = tau / (tau + 7.7) for cloud over a dark surface
 *   (two-stream approximation, asymmetry 0.85), so tau = 7.7 R / (1 - R). Bright cloud is thick; cirrus that the sun shines through is dim.
 *   By night there is no visible picture: tau is guessed from the kind of cloud the top says it is.
 * - Base: the kind of cloud the top and thickness say it is. Low cloud (tops under 3 km: cumulus, stratocumulus) and anything thick and
 *   deep (cumulus congestus, nimbostratus, cumulonimbus) stand on the condensation level, about 1 km up over South India; a thin middle
 *   cloud (altocumulus, altostratus) is a layer about 1.2 km deep under its top; thin high cloud (cirrus) a layer about 1.8 km deep.
 *
 * Packed as RGBA bytes: R cover (0..1), G top (km / 20), B base (km / 20), A sqrt(tau / 80).
 */
import { irLumaToTempC, irTempToHeightKm, mercatorRowMap } from './satellite-image';
import { SatelliteChannel } from './satellite.config';

export const FIELD_KM_SCALE = 20;
export const FIELD_TAU_MAX = 80;
/** The grid is at most this wide (about 6 km a cell over India): finer than the infrared, and the GPU adds the small-scale detail. */
export const FIELD_MAX_WIDTH = 512;

export interface CloudField {
  w: number;
  h: number;
  /** RGBA bytes, row 0 at the north edge, rows spaced in Mercator like the overlay picture. */
  data: Uint8Array<ArrayBuffer>;
}

export interface CloudColumn {
  cover: number;
  topKm: number;
  baseKm: number;
  tau: number;
}

/** Cloud base over South India: the lifting condensation level of the moist tropical air (km). */
const CONDENSATION_KM = 1.0;

/** Optical thickness from the visible brightness of cloud (0..1 of the picture's scale). */
export function tauFromReflectance(r: number): number {
  const c = Math.min(0.92, Math.max(0, r));
  return Math.min(FIELD_TAU_MAX, (7.7 * c) / (1 - c));
}

/** Optical thickness of a cloud seen only in the infrared (night), from its top: deep cold tops are storms, thin high tops cirrus. */
export function tauFromTop(topKm: number, tempC: number): number {
  if (tempC < -55) return 45; // a cumulonimbus anvil over its tower
  if (topKm > 7) return 2.5; // cirrus
  if (topKm > 3) return 12; // middle cloud
  return 10; // low cloud
}

/** The column of a cell: its top (km), base and thickness, from the cloud-top temperature and (by day) the optical thickness. */
export function cloudColumn(cover: number, tempC: number, tau: number): CloudColumn {
  const topKm = Math.max(0.6, irTempToHeightKm(tempC));
  let baseKm: number;
  if (topKm < 3) baseKm = Math.min(CONDENSATION_KM, topKm - 0.3); // cumulus, stratocumulus, stratus
  else if (tau >= 20) baseKm = CONDENSATION_KM; // congestus, nimbostratus, cumulonimbus: from the condensation level to the top
  else if (topKm <= 7) baseKm = topKm - 1.2; // altocumulus, altostratus
  else baseKm = topKm - 1.8; // cirrus, cirrostratus
  return { cover, topKm, baseKm: Math.max(0.2, baseKm), tau };
}

/**
 * The cloud field of a finished frame. `src` is the picture as fetched (`width` x `srcHeight`, latitude rows) after its smoothing;
 * `cover` is how much of each overlay pixel is cloud (`width` x `outHeight`, Mercator rows), for HRV frames (null for an infrared one,
 * whose cover comes from the temperature here). `background` is the HRV picture's typical blue of land and sea (hrvBackground).
 */
export function buildCloudField(
  src: Uint8ClampedArray,
  width: number,
  srcHeight: number,
  kind: SatelliteChannel,
  outHeight: number,
  cover: Uint8Array | null,
  background: number,
): CloudField {
  const step = Math.max(1, Math.ceil(width / FIELD_MAX_WIDTH));
  const w = Math.ceil(width / step);
  const h = Math.ceil(outHeight / step);
  const data = new Uint8Array(w * h * 4);
  const rowMap = mercatorRowMap(srcHeight, outHeight);
  const floor = Math.max(0, background - 18);
  const span = Math.max(1, 255 - floor);
  // the infrared's brightness of a pixel (0 warm .. 1 the coldest top)
  const lumaAt = (p: number) => (kind === 'hrv' ? Math.max(0, (src[p + 2] - floor) / span) : (src[p] + src[p + 1] + src[p + 2]) / (3 * 255));

  // at night the clear ground is the warmest common brightness: the picture's median, cloud being much less than half of it
  let groundLuma = 0;
  if (kind !== 'hrv') {
    const hist = new Uint32Array(256);
    let n = 0;
    for (let i = 0; i < src.length; i += 4 * 7) {
      if (src[i] + src[i + 1] + src[i + 2] === 0) continue;
      hist[Math.round((src[i] + src[i + 1] + src[i + 2]) / 3)]++;
      n++;
    }
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= n / 2) {
        groundLuma = v / 255;
        break;
      }
    }
  }

  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      let coverSum = 0;
      let count = 0;
      let coldest = 0;
      let lumaSum = 0;
      let reflSum = 0;
      let cloudy = 0;
      for (let y = cy * step; y < Math.min(outHeight, (cy + 1) * step); y++) {
        const sy = Math.min(srcHeight - 1, Math.round(rowMap[y]));
        for (let x = cx * step; x < Math.min(width, (cx + 1) * step); x++) {
          const p = (sy * width + x) * 4;
          if (src[p] + src[p + 1] + src[p + 2] === 0) continue; // no data
          const luma = lumaAt(p);
          // how much of the pixel is cloud: the overlay's own measure by day; by night how much colder it is than the clear ground
          const hasHrv = kind === 'hrv' && (src[p] + src[p + 1]) / 2 > 7;
          let c: number;
          if (cover && hasHrv) c = cover[y * width + x] / 255;
          else if (kind === 'hrv') c = smoothstep(0.22, 0.6, luma); // no HRV here (the night side, or a gap): the infrared, as the overlay does
          else c = smoothstep(0.05, 0.16, luma - groundLuma);
          coverSum += c;
          count++;
          if (c > 0.3) {
            cloudy++;
            lumaSum += luma;
            if (luma > coldest) coldest = luma;
            reflSum += hasHrv ? (src[p] + src[p + 1]) / (2 * 255) : -1;
          }
        }
      }
      const o = (cy * w + cx) * 4;
      if (count === 0 || cloudy === 0) continue;
      const coverMean = coverSum / count;
      // the top from the coldest cloud in the cell, steadied by the mean of its cloud
      const luma = 0.6 * coldest + 0.4 * (lumaSum / cloudy);
      const tempC = irLumaToTempC(luma);
      const refl = reflSum / cloudy;
      const topGuess = irTempToHeightKm(tempC);
      const tau = refl >= 0 ? tauFromReflectance(refl) : tauFromTop(topGuess, tempC);
      const col = cloudColumn(coverMean, tempC, tau);
      data[o] = Math.round(255 * Math.min(1, col.cover));
      data[o + 1] = Math.round((255 * Math.min(FIELD_KM_SCALE, col.topKm)) / FIELD_KM_SCALE);
      data[o + 2] = Math.round((255 * Math.min(FIELD_KM_SCALE, col.baseKm)) / FIELD_KM_SCALE);
      data[o + 3] = Math.round(255 * Math.sqrt(col.tau / FIELD_TAU_MAX));
    }
  }
  return { w, h, data };
}

/** The column packed in a cell of a field (for tests and the hover readout). */
export function readColumn(field: CloudField, cx: number, cy: number): CloudColumn {
  const o = (cy * field.w + cx) * 4;
  const d = field.data;
  return {
    cover: d[o] / 255,
    topKm: (d[o + 1] / 255) * FIELD_KM_SCALE,
    baseKm: (d[o + 2] / 255) * FIELD_KM_SCALE,
    tau: Math.pow(d[o + 3] / 255, 2) * FIELD_TAU_MAX,
  };
}

function smoothstep(lo: number, hi: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}
