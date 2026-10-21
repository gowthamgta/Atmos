import type { RadarProductKey, RadarStationConfig } from '../domain/models/radar.model';

/**
 * How high above sea level a radar's beam passes over a place: the beam leaves the antenna almost flat, climbs at the sweep's angle and the
 * Earth curves away beneath it, so far from a radar only rain high up is seen. Same assumptions as the coverage map (pipeline/radar_coverage.py):
 * the lowest sweep at 0.5 degrees, a 1 degree wide beam, and the usual bending of the beam by the air (an Earth 4/3 its real size).
 */
export const LOWEST_SWEEP_DEG = 0.5;
export const BEAM_WIDTH_DEG = 1;
/** Both radars stand on the coast: the antenna is about 50 m above the sea. */
export const ANTENNA_KM = 0.05;
const EARTH_KM = 6371;
const EFFECTIVE_EARTH_KM = (EARTH_KM * 4) / 3;

/** Height (km above sea level) of a ray leaving the antenna at `elevationDeg`, after `rangeKm` along the ground. */
export function beamHeightKm(rangeKm: number, elevationDeg: number, antennaKm = ANTENNA_KM): number {
  const r = rangeKm;
  const R = EFFECTIVE_EARTH_KM;
  const h = Math.sqrt(r * r + R * R + 2 * r * R * Math.sin((elevationDeg * Math.PI) / 180)) - R + antennaKm;
  return Math.max(antennaKm, h);
}

/** Distance along the ground (km) between two places. */
export function groundDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface BeamOverPlace {
  stationId: string;
  name: string;
  distanceKm: number;
  /** The centre of the lowest sweep, and the bottom and top of the beam (km above sea level). */
  centreKm: number;
  bottomKm: number;
  topKm: number;
}

/**
 * The lowest sweep of each radar over a place, for the radars whose picture of `product` reaches it (inside the range circle; the PPI picture
 * is square, so anywhere inside its box), nearest radar first.
 */
export function beamsOverPlace(
  stations: readonly RadarStationConfig[],
  product: RadarProductKey,
  lat: number,
  lng: number,
  include: (stationId: string) => boolean = () => true,
): BeamOverPlace[] {
  const out: BeamOverPlace[] = [];
  for (const st of stations) {
    if (!include(st.id)) continue;
    const config = st.products[product];
    if (!config) continue;
    const d = groundDistanceKm(st.lat, st.lng, lat, lng);
    if (product === 'ppi') {
      const [[s, w], [n, e]] = config.bounds;
      if (lat < s || lat > n || lng < w || lng > e) continue;
    } else if (d > config.rangeKm) continue;
    out.push({
      stationId: st.id,
      name: st.name.replace(' X-DWR', '').replace(' DWR', ''),
      distanceKm: d,
      centreKm: beamHeightKm(d, LOWEST_SWEEP_DEG),
      bottomKm: beamHeightKm(d, LOWEST_SWEEP_DEG - BEAM_WIDTH_DEG / 2),
      topKm: beamHeightKm(d, LOWEST_SWEEP_DEG + BEAM_WIDTH_DEG / 2),
    });
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

/** Below this beam height (centre of the lowest sweep, km) an echo is drawn in full; above `ALOFT_FULL_KM` a faint one is see-through. */
export const ALOFT_START_KM = 2;
export const ALOFT_FULL_KM = 3.5;
/** Echoes from 30 dBZ (intensity 1.875) up are always drawn in full; from 25 dBZ (1.35) down a high one is see-through. */
const ALOFT_FAINT_FULL = 1.35;
const ALOFT_FAINT_NONE = 1.875;
/** How see-through a faint echo seen only from high up is drawn (its opacity, 0..1): never hidden. */
export const ALOFT_MIN_OPACITY = 0.45;

function smoothstep(lo: number, hi: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/**
 * Opacity (0..1) of an echo of intensity `v` (dBZ = 12 + 9.6 v) seen from a beam `heightKm` up: faint echoes seen only from high up are
 * mostly rain that dries up before it lands (or cloud), so they are drawn see-through, never removed; strong ones stay solid.
 */
export function aloftOpacity(v: number, heightKm: number): number {
  const high = smoothstep(ALOFT_START_KM, ALOFT_FULL_KM, heightKm);
  const faint = 1 - smoothstep(ALOFT_FAINT_FULL, ALOFT_FAINT_NONE, v);
  return 1 - (1 - ALOFT_MIN_OPACITY) * high * faint;
}

/** True when an echo of `dbz` seen from `heightKm` up is drawn see-through as rain aloft. */
export function isRainAloft(dbz: number, heightKm: number): boolean {
  return aloftOpacity((dbz - 12) / 9.6, heightKm) < 0.9;
}

/**
 * The centre height (km) of the lowest sweep over each pixel of a picture `width` x `height` with corners `coordinates` ([lng, lat] NW, NE,
 * SE, SW; rows evenly spaced in latitude): the lowest of the radars whose picture of `product` reaches it, Infinity where none does.
 */
export function lowestBeamHeights(
  stations: readonly RadarStationConfig[],
  product: RadarProductKey,
  coordinates: readonly (readonly [number, number])[],
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(width * height).fill(Infinity);
  const west = coordinates[0][0], east = coordinates[1][0], north = coordinates[0][1], south = coordinates[2][1];
  for (const st of stations) {
    const config = st.products[product];
    if (!config) continue;
    const cosLat = Math.cos((st.lat * Math.PI) / 180);
    const [[bs, bw], [bn, be]] = config.bounds;
    for (let y = 0; y < height; y++) {
      const lat = north - (y / (height - 1)) * (north - south);
      if (product === 'ppi' && (lat < bs || lat > bn)) continue;
      const dy = (lat - st.lat) * 111.32;
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const lng = west + (x / (width - 1)) * (east - west);
        const dx = (lng - st.lng) * 111.32 * cosLat;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (product === 'ppi' ? lng < bw || lng > be : d > config.rangeKm) continue;
        const h = beamHeightKm(d, LOWEST_SWEEP_DEG);
        if (h < out[row + x]) out[row + x] = h;
      }
    }
  }
  return out;
}

/**
 * The fade of a mosaic with rain aloft see-through (see aloftOpacity), multiplied into its existing `fade` (255: in full), or the same
 * `fade` when no pixel changes. `field` is the mosaic's intensity, `heights` from lowestBeamHeights on the same grid.
 */
export function withAloftFade(field: Float32Array, heights: Float32Array, fade?: Uint8Array): Uint8Array | undefined {
  let out: Uint8Array | undefined;
  for (let i = 0; i < field.length; i++) {
    const v = field[i];
    if (v <= 0 || v >= ALOFT_FAINT_NONE || heights[i] <= ALOFT_START_KM) continue;
    const a = aloftOpacity(v, heights[i]);
    if (a >= 1) continue;
    if (!out) out = fade ? new Uint8Array(fade) : new Uint8Array(field.length).fill(255);
    out[i] = Math.round(out[i] * a);
  }
  return out ?? fade;
}
