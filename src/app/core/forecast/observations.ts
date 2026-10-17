/** Observed weather near a clicked point, from the files the observations workflow commits (see pipeline/obs_tnsmart.py, obs_metar.py). */

/** One Tamil Nadu rain gauge in rain/latest.json: total of the day's 24 h window and its wettest hour. */
export interface RainGauge {
  n: string;
  d: string;
  la: number;
  lo: number;
  t: number | null;
  pk: number | null;
  pt: string | null;
  h: number;
}

export interface RainSummary {
  date: string;
  window: string;
  stations: RainGauge[];
}

export interface MetarRecord {
  station: string;
  name: string | null;
  lat: number;
  lon: number;
  time: string;
  temp_c: number | null;
  dewp_c: number | null;
  rh_pct: number | null;
  wind_dir: number | string | null;
  wind_kt: number | null;
  gust_kt: number | null;
  pressure_hpa: number | null;
}

/** One SYNOP report of a Tamil Nadu weather station (synop/latest.json; see pipeline/obs_synop.py). */
export interface SynopRecord {
  station: string;
  name: string;
  lat: number;
  lon: number;
  time: string;
  temp_c: number | null;
  dewp_c: number | null;
  rh_pct: number | null;
  wind_dir: number | null;
  wind_kt: number | null;
  msl_hpa: number | null;
  stn_hpa: number | null;
  wind_ms: number | null;
  rain_mm: number | null;
  rain_hours: number | null;
  rain24_mm: number | null;
  tmax_c: number | null;
  tmin_c: number | null;
}

export interface SynopFile {
  stations: Record<string, SynopRecord[]>;
}

export interface MetarFile {
  stations: Record<string, MetarRecord[]>;
}

/** Furthest a rain gauge may be to speak for a point, and an airport to speak for the air there. */
export const GAUGE_RADIUS_KM = 15;
export const AIRPORT_RADIUS_KM = 120;
export const STATION_RADIUS_KM = 100;

/** Great-circle distance in km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export interface Nearest<T> {
  item: T;
  km: number;
}

/** The closest gauge within the radius that has a reading, or null. */
export function nearestGauge(gauges: readonly RainGauge[], lat: number, lon: number, radiusKm = GAUGE_RADIUS_KM): Nearest<RainGauge> | null {
  let best: Nearest<RainGauge> | null = null;
  for (const g of gauges) {
    if (g.t === null) continue;
    const km = distanceKm(lat, lon, g.la, g.lo);
    if (km <= radiusKm && (!best || km < best.km)) best = { item: g, km };
  }
  return best;
}

/** The newest report of each airport (the last of its list, which is sorted oldest first). */
export function latestReports(file: MetarFile): MetarRecord[] {
  return Object.values(file.stations).flatMap(rows => (rows.length ? [rows[rows.length - 1]] : []));
}

/** The closest report (of any kind with a position) within the radius, or null. */
export function nearestReport<T extends { lat: number; lon: number }>(reports: readonly T[], lat: number, lon: number, radiusKm: number): Nearest<T> | null {
  let best: Nearest<T> | null = null;
  for (const r of reports) {
    if (r.lat == null || r.lon == null) continue;
    const km = distanceKm(lat, lon, r.lat, r.lon);
    if (km <= radiusKm && (!best || km < best.km)) best = { item: r, km };
  }
  return best;
}

/** The closest airport with a report within the radius, or null. */
export function nearestAirport(reports: readonly MetarRecord[], lat: number, lon: number, radiusKm = AIRPORT_RADIUS_KM): Nearest<MetarRecord> | null {
  return nearestReport(reports, lat, lon, radiusKm);
}

/** The newest report of each weather station that has a temperature in it (the newest one can be a rain-only report). */
export function latestStationReports(file: SynopFile): SynopRecord[] {
  return Object.values(file.stations).flatMap(rows => {
    const withTemp = rows.filter(r => r.temp_c !== null);
    return withTemp.length ? [withTemp[withTemp.length - 1]] : [];
  });
}

/** The newest report of every station, whatever it holds (these are the station markers on the map). */
export function latestPerStation(file: SynopFile): SynopRecord[] {
  return Object.values(file.stations).flatMap(rows => (rows.length ? [rows[rows.length - 1]] : []));
}

/** Map layer ids of the weather station markers (see MapComponent and StationCardComponent). */
export const STATION_SOURCE = 'obs-stations';
export const STATION_CIRCLE_LAYER = 'obs-station-circles';
export const STATION_LABEL_LAYER = 'obs-station-labels';

/** The closest weather station with a report within the radius, or null. */
export function nearestStation(reports: readonly SynopRecord[], lat: number, lon: number, radiusKm = STATION_RADIUS_KM): Nearest<SynopRecord> | null {
  return nearestReport(reports, lat, lon, radiusKm);
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** "WSW" for a wind direction in degrees; variable winds and missing values come back as given or "variable". */
export function compassPoint(dir: number | string | null): string {
  if (dir === null || dir === undefined) return '';
  const deg = typeof dir === 'number' ? dir : Number(dir);
  return Number.isFinite(deg) ? COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16] : 'variable';
}

/** How old a report is, as "40 min ago" / "3 h ago" (nowMs is injectable for tests). */
export function ageLabel(iso: string, nowMs = Date.now()): string {
  const min = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  return min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

/** The minute of every hour at which the weather stations and airports are asked again (their reports come out at about :00 and :30). */
export const OBSERVATION_MINUTE = 32;

/** The newest time at or before `nowMs` that was minute :32 of an hour: a load made before it is out of date. */
export function lastObservationSlot(nowMs: number): number {
  const hour = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const slot = hour + OBSERVATION_MINUTE * 60_000;
  return slot <= nowMs ? slot : slot - 3_600_000;
}

/** Milliseconds from `nowMs` to the next minute :32 of an hour (a full hour when it is exactly :32). */
export function msToNextObservationSlot(nowMs: number): number {
  return lastObservationSlot(nowMs) + 3_600_000 - nowMs;
}
