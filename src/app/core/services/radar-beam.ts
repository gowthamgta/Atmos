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
