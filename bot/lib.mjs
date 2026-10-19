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

/** A point `km` from (lat, lon) towards `deg` (flat earth: fine for the tens of km a storm covers in an hour). */
export function offsetKm(lat, lon, km, deg) {
  const a = (deg * Math.PI) / 180;
  return [lat + (km * Math.cos(a)) / 111.2, lon + (km * Math.sin(a)) / (111.2 * Math.cos((lat * Math.PI) / 180))];
}

/**
 * How far from the region a storm still counts as the region's: over the sea, 25 km (storms off the coast drift ashore, and the coast sees
 * them); over a neighbouring state, its own size plus 10 km, so it is on the border (Bengaluru, about 30 km from Krishnagiri district, is
 * not Tamil Nadu's storm). A storm further out that is heading in is caught by `towards` instead.
 */
export const NEAR_COAST_KM = 25;
export const NEAR_BORDER_KM = 10;

/**
 * Where a storm cell is, in the words of an alert: `over`, the region's districts its area covers (sampled over its whole size, not only
 * its centre, so a storm on a border names both sides; the one under the centre first); `near`, when its centre is outside the region,
 * the closest district within reach (NEAR_COAST_KM over the sea, the storm's size and NEAR_BORDER_KM over land) and whether the centre
 * is over the sea; `towards`, the districts its centre reaches in the next 30
 * and 60 minutes along its motion that it is not already over. `land` is every district of the boundary file (all states), to tell sea
 * from land.
 */
export function stormPlaces(cell, districts, land) {
  const count = new Map();
  const add = (lat, lon, weight) => {
    const d = districtAt(lat, lon, districts);
    if (d) count.set(d.name, (count.get(d.name) ?? 0) + weight);
  };
  add(cell.lat, cell.lon, 100);
  for (const f of [0.5, 1]) for (let deg = 0; deg < 360; deg += 45) add(...offsetKm(cell.lat, cell.lon, cell.radiusKm * f, deg), f === 0.5 ? 2 : 1);
  const over = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);

  let near = null;
  if (!districtAt(cell.lat, cell.lon, districts)) {
    const offshore = districtAt(cell.lat, cell.lon, land) === null;
    const reach = offshore ? NEAR_COAST_KM : cell.radiusKm + NEAR_BORDER_KM;
    for (let km = 2.5; km <= reach && !near; km += 2.5) {
      for (let deg = 0; deg < 360; deg += 22.5) {
        const d = districtAt(...offsetKm(cell.lat, cell.lon, km, deg), districts);
        if (d) {
          near = { name: d.name, km, offshore };
          break;
        }
      }
    }
  }

  const towards = [];
  if (cell.speedKmh !== null && cell.speedKmh >= 5) {
    for (const minutes of [30, 60]) {
      const d = districtAt(...offsetKm(cell.lat, cell.lon, (cell.speedKmh * minutes) / 60, cell.towardsDeg), districts);
      if (d && !over.includes(d.name) && !towards.includes(d.name)) towards.push(d.name);
    }
  }
  return { over, near, towards };
}

/** Every district a set of alert cells concerns (over, near or heading for), strongest storms first. */
export function placeNames(cells) {
  return [...new Set(cells.flatMap(c => [...c.places.over, ...(c.places.near ? [c.places.near.name] : []), ...c.places.towards]))];
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
 * ALERT_DBZ over the region, just off its coast or on its border (NEAR_COAST_KM, NEAR_BORDER_KM), or heading into it within the hour; strongest
 * first, each with its places (see stormPlaces).
 */
export function alertCells(snapshot, districts, land = districts, minDbz = ALERT_DBZ) {
  return snapshot.cells
    .filter(c => c.dbz >= minDbz)
    .map(c => ({ ...c, places: stormPlaces(c, districts, land) }))
    .filter(c => c.places.over.length > 0 || c.places.near !== null || c.places.towards.length > 0)
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
  const districts = placeNames(cells);
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

/**
 * Where the storms are, in words, with at most `n` names in each part: "over A, B, off the C coast, near D" and "towards E, F". The
 * districts they are over come first, strongest storms first.
 */
export function describePlaces(cells, n = 5) {
  const over = [...new Set(cells.flatMap(c => c.places.over))];
  const offshore = [...new Set(cells.filter(c => c.places.over.length === 0 && c.places.near?.offshore).map(c => c.places.near.name))];
  const inland = [...new Set(cells.filter(c => c.places.over.length === 0 && c.places.near && !c.places.near.offshore).map(c => c.places.near.name))];
  const named = new Set([...over, ...offshore, ...inland]);
  const towards = [...new Set(cells.flatMap(c => c.places.towards))].filter(d => !named.has(d));
  const cut = list => (list.length > n ? [...list.slice(0, n), `+${list.length - n} more`] : list);
  const where = [
    ...(over.length ? [`over ${cut(over).join(', ')}`] : []),
    ...cut(offshore).map(d => `off the ${d} coast`),
    ...(inland.length ? [`near ${cut(inland).join(', ')}`] : []),
  ];
  return {
    where: where.length ? where.join(' and ') : `approaching ${cut(towards).join(', ')}`,
    towards: where.length && towards.length ? cut(towards).join(', ') : '',
  };
}

/**
 * The post's text (at most `maxLength` as X counts it: 280 on X, more for Telegram and Discord): what, where, how strong, where the storms
 * go in the next hour, when, and that it is not an official warning.
 */
export function composePost(cells, radarTimeMs, { link = '', hashtags = '#TamilNaduRains #TNWeather', maxLength = 280 } = {}) {
  const peak = cells[0].dbz;
  const headline = peak >= SEVERE_DBZ ? '⛈️ Severe thunderstorm' : peak >= STRONG_DBZ ? '⛈️ Strong thunderstorms' : '🌧️ Heavy rain / thunderstorms';
  const moving = cells.find(c => c.speedKmh !== null && c.speedKmh >= 5);
  const motion = moving ? ` · moving ${compass(moving.towardsDeg)} ~${moving.speedKmh} km/h` : '';
  const lines = (n, advice, tags) => {
    const { where, towards } = describePlaces(cells, n);
    return [
      `${headline} ${where}`,
      `Peak ${peak} dBZ${motion}`,
      // the districts all the storms reach, on a line of their own: not only where the strongest one (whose motion is above) goes
      ...(towards ? [`Next hour: ${towards}`] : []),
      ...(advice ? ['Heavy rain & lightning likely in and near these areas.'] : []),
      `IMD radar ${istClock(radarTimeMs)} · automated nowcast, not an official warning`,
      ...(link ? [link] : []),
      ...(tags && hashtags ? [hashtags] : []),
    ].join('\n');
  };
  // as many names as fit; then without the advice line, then without the hashtags: never a text cut short. The headline, the strength,
  // the time and "not an official warning" always stay.
  for (const [advice, tags] of [[true, true], [false, true], [false, false]]) {
    for (let n = 5; n >= 1; n--) {
      const text = lines(n, advice, tags);
      if (xLength(text) <= maxLength) return text;
    }
  }
  return lines(1, false, false);
}

/** The screenshot's alt text, for people using screen readers. */
export function altText(cells, radarTimeMs) {
  const { where, towards } = describePlaces(cells, 12);
  return `IMD Doppler radar mosaic of Tamil Nadu at ${istClock(radarTimeMs)}, showing storm cells up to ${cells[0].dbz} dBZ ${where}${towards ? `, heading towards ${towards}` : ''}, with their expected paths for the next hour.`.slice(0, 1000);
}

/** What to remember after a post. */
export function stateAfterPost(cells, snapshot, nowMs) {
  return {
    lastPostMs: nowMs,
    lastPeakDbz: cells[0].dbz,
    lastDistricts: placeNames(cells),
    lastRadarMs: snapshot.radarTimeMs,
  };
}

/** The Telegram channel the alerts go to (the bot must be one of its admins, allowed to post). */
export const TELEGRAM_CHAT = '@tnweatheralerts';

/**
 * The Telegram caption (at most 1024 characters): the same alert as on X, and the live radar's address, which costs nothing there.
 */
export function composeTelegram(cells, radarTimeMs, link = 'https://atmosradar.netlify.app') {
  return `${composePost(cells, radarTimeMs, { maxLength: 950 })}\n\nLive radar: ${link}`;
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

/** The embed's colour bar by how strong the storms are: amber heavy rain, orange strong, red severe. */
export function alertColor(peak) {
  return peak >= SEVERE_DBZ ? 0xe53935 : peak >= STRONG_DBZ ? 0xfb8c00 : 0xfdd835;
}

/**
 * The Discord message: an embed with the alert (the headline as its title, the rest as its text), the radar picture inside it, the radar's
 * time as its timestamp and the live radar as its link. No one is pinged (allowed_mentions empty).
 */
export function discordPayload(cells, radarTimeMs, link = 'https://atmosradar.netlify.app') {
  const [title, ...rest] = composePost(cells, radarTimeMs, { hashtags: '', maxLength: 3500 }).trim().split('\n');
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: title.slice(0, 256),
      url: link,
      description: `${rest.join('\n')}\n[Live radar](${link})`.slice(0, 4096),
      color: alertColor(cells[0].dbz),
      image: { url: 'attachment://radar.png' },
      timestamp: new Date(radarTimeMs).toISOString(),
      footer: { text: 'IMD Doppler radar · AtmosIQ nowcast' },
    }],
  };
}

/**
 * Posts the alert and the radar picture to a Discord channel through its webhook (`fetchFn` is the global fetch; the tests give their
 * own). Returns the message id; throws with Discord's own explanation when it refuses (a deleted or wrong webhook...).
 */
export async function sendDiscord(webhookUrl, png, payload, fetchFn = fetch) {
  const form = new FormData();
  form.set('payload_json', JSON.stringify(payload));
  form.set('files[0]', new Blob([png], { type: 'image/png' }), 'radar.png');
  const url = `${webhookUrl}${webhookUrl.includes('?') ? '&' : '?'}wait=true`; // wait: Discord answers with the message
  const res = await fetchFn(url, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Discord refused the post: ${body.message ?? res.status}`);
  return body.id;
}
