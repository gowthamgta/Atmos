// The nowcast bot's decisions, kept apart from the browser and from X so they can be tested on their own (lib.test.mjs).

/** Reflectivity (dBZ) of a cell worth an alert: heavy rain, usually a thunderstorm. */
export const ALERT_DBZ = 45;
/** A strong thunderstorm, and a severe one (hail, damaging gusts likely). */
export const STRONG_DBZ = 50;
export const SEVERE_DBZ = 54;
/** After a post, the bot stays quiet this long, unless the storms clearly get worse or reach new districts. */
export const COOLDOWN_MIN = 60;
export const ESCALATE_DBZ = 5;
/** A live radar picture older than this is not posted about (the radar is stale or stuck). */
export const MAX_RADAR_AGE_MIN = 40;
/** The region watched: the districts of these states (from the app's boundary file). */
export const REGION_STATES = ['Tamil Nadu', 'Puducherry'];

/** Whether a point is inside a GeoJSON ring (ray casting; [lon, lat] pairs). */
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether a point is inside a Polygon or MultiPolygon (holes respected). */
export function inGeometry(lon, lat, geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(([outer, ...holes]) => inRing(lon, lat, outer) && !holes.some(h => inRing(lon, lat, h)));
}

/** The districts of the watched states, from the app's boundary GeoJSON, each with its bounding box for a quick first test. */
export function regionDistricts(geojson, states = REGION_STATES) {
  return geojson.features
    .filter(f => f.properties?.kind === 'district' && states.includes(f.properties.state))
    .map(f => {
      const pts = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).flat(2);
      const lons = pts.map(p => p[0]);
      const lats = pts.map(p => p[1]);
      return {
        name: f.properties.name,
        state: f.properties.state,
        geometry: f.geometry,
        box: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
      };
    });
}

/** The district a point is in (null outside the region). */
export function districtAt(lat, lon, districts) {
  for (const d of districts) {
    const [w, s, e, n] = d.box;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    if (inGeometry(lon, lat, d.geometry)) return d;
  }
  return null;
}

/** Compass point (8) a direction (degrees, towards) is closest to. */
export function compass(deg) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/**
 * The storms worth an alert on a snapshot of the live radar (from the app, see src/app/core/ui/bot-capture.ts): the cells of at least
 * ALERT_DBZ inside the region, strongest first, each with its district.
 */
export function alertCells(snapshot, districts, minDbz = ALERT_DBZ) {
  return snapshot.cells
    .filter(c => c.dbz >= minDbz)
    .map(c => ({ ...c, district: districtAt(c.lat, c.lon, districts) }))
    .filter(c => c.district !== null)
    .sort((a, b) => b.dbz - a.dbz);
}

/**
 * Whether to post now. `state` is what the last post left ({ lastPostMs, lastPeakDbz, lastDistricts, lastRadarMs }, or {}). Returns
 * { post, reason }.
 */
export function decide(cells, snapshot, state, nowMs) {
  if (!snapshot.radarTimeMs) return { post: false, reason: 'no live radar picture' };
  const ageMin = (nowMs - snapshot.radarTimeMs) / 60_000;
  if (ageMin > MAX_RADAR_AGE_MIN) return { post: false, reason: `the radar picture is ${Math.round(ageMin)} min old` };
  if (cells.length === 0) return { post: false, reason: 'no storm in the region' };
  if (state.lastRadarMs === snapshot.radarTimeMs) return { post: false, reason: 'this radar picture was already posted about' };
  const peak = cells[0].dbz;
  const districts = [...new Set(cells.map(c => c.district.name))];
  const sinceMin = state.lastPostMs ? (nowMs - state.lastPostMs) / 60_000 : Infinity;
  if (sinceMin >= COOLDOWN_MIN) return { post: true, reason: 'storms in the region' };
  if (peak >= (state.lastPeakDbz ?? 0) + ESCALATE_DBZ) return { post: true, reason: `the storms got stronger (${state.lastPeakDbz} -> ${peak} dBZ)` };
  const fresh = districts.filter(d => !(state.lastDistricts ?? []).includes(d));
  if (fresh.length > 0) return { post: true, reason: `storms reached ${fresh.join(', ')}` };
  return { post: false, reason: `posted ${Math.round(sinceMin)} min ago and nothing changed much` };
}

/** "15:40 IST" for a time in epoch ms. */
export function istClock(ms) {
  const d = new Date(ms + 5.5 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} IST`;
}

/** How X counts a post's length: most characters 1, emoji and other wide characters 2 (enough for the text this bot writes). */
export function xLength(text) {
  let n = 0;
  for (const ch of text) n += ch.codePointAt(0) > 0x2fff ? 2 : 1;
  return n;
}

/** The post's text (at most 280 as X counts it): what, where, how strong, where it is going, when, and that it is not an official warning. */
export function composePost(cells, radarTimeMs, { link = '', hashtags = '#TamilNaduRains #TNWeather' } = {}) {
  const peak = cells[0].dbz;
  const headline = peak >= SEVERE_DBZ ? '⛈️ Severe thunderstorm' : peak >= STRONG_DBZ ? '⛈️ Strong thunderstorms' : '🌧️ Heavy rain / thunderstorms';
  const moving = cells.find(c => c.speedKmh !== null && c.speedKmh >= 5);
  const motion = moving ? ` · moving ${compass(moving.towardsDeg)} ~${moving.speedKmh} km/h` : '';
  const tail = [
    `Peak ${peak} dBZ${motion}`,
    'Heavy rain & lightning likely in and near these areas in the next hour.',
    `IMD radar ${istClock(radarTimeMs)} · automated nowcast, not an official warning`,
    ...(link ? [link] : []),
    hashtags,
  ].join('\n');
  const all = [...new Set(cells.map(c => c.district.name))];
  // as many districts as fit, strongest storms first
  for (let n = Math.min(all.length, 5); n >= 1; n--) {
    const more = all.length > n ? ` +${all.length - n} more` : '';
    const text = `${headline} over ${all.slice(0, n).join(', ')}${more}\n${tail}`;
    if (xLength(text) <= 280) return text;
  }
  return `${headline} over ${all[0]}\n${tail}`.slice(0, 270);
}

/** The screenshot's alt text, for people using screen readers. */
export function altText(cells, radarTimeMs) {
  const all = [...new Set(cells.map(c => c.district.name))];
  return `IMD Doppler radar mosaic of Tamil Nadu at ${istClock(radarTimeMs)}, showing storm cells up to ${cells[0].dbz} dBZ over ${all.join(', ')}, with their expected paths for the next hour.`.slice(0, 1000);
}

/** What to remember after a post. */
export function stateAfterPost(cells, snapshot, nowMs) {
  return {
    lastPostMs: nowMs,
    lastPeakDbz: cells[0].dbz,
    lastDistricts: [...new Set(cells.map(c => c.district.name))],
    lastRadarMs: snapshot.radarTimeMs,
  };
}

/** The Telegram channel the alerts go to (the bot must be one of its admins, allowed to post). */
export const TELEGRAM_CHAT = '@tnweatheralerts';

/**
 * The Telegram caption (at most 1024 characters): the same alert as on X, and the live radar's address, which costs nothing there.
 */
export function composeTelegram(cells, radarTimeMs, link = 'https://atmosradar.netlify.app') {
  return `${composePost(cells, radarTimeMs)}\n\nLive radar: ${link}`.slice(0, 1024);
}

/**
 * Sends the radar picture with its caption to a Telegram chat through the Bot API (`fetchFn` is the global fetch; the tests give their
 * own). Returns the message id; throws with Telegram's own explanation when it refuses (a wrong token, a bot that is not an admin of the
 * channel...).
 */
export async function sendTelegram(token, chatId, png, caption, fetchFn = fetch) {
  const form = new FormData();
  form.set('chat_id', chatId);
  form.set('caption', caption);
  form.set('photo', new Blob([png], { type: 'image/png' }), 'radar.png');
  const res = await fetchFn(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`Telegram refused the post: ${body.description ?? res.status}`);
  return body.result.message_id;
}
