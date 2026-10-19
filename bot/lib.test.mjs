import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ALERT_DBZ, COOLDOWN_MIN, TELEGRAM_CHAT, alertCells, altText, compass, composePost, composeTelegram, decide, describePlaces, districtAt,
  regionDistricts, sendTelegram, stateAfterPost, stormPlaces, xLength, discordPayload, sendDiscord, alertColor,
} from './lib.mjs';

const boundaries = JSON.parse(readFileSync(new URL('../public/data/south-india-districts.geojson', import.meta.url), 'utf8'));
const districts = regionDistricts(boundaries);
const land = regionDistricts(boundaries, [...new Set(boundaries.features.map(f => f.properties?.state).filter(Boolean))]);
const NOW = Date.UTC(2026, 9, 19, 10, 30);
const MIN = 60_000;
const cell = (lat, lon, dbz, speedKmh = 20, towardsDeg = 45, radiusKm = 8) => ({ lat, lon, dbz, radiusKm, speedKmh, towardsDeg });
const snap = (cells, ageMin = 10) => ({ radarTimeMs: NOW - ageMin * MIN, motionSource: 'radar', loopLoaded: true, cells });

test('knows the districts of Tamil Nadu and Puducherry, and nothing outside them', () => {
  assert.equal(districts.length, 41);
  assert.equal(districtAt(11.74, 78.96, districts)?.name, 'Kallakurichi');
  assert.equal(districtAt(13.08, 80.27, districts)?.name, 'Chennai');
  assert.equal(districtAt(11.93, 79.83, districts)?.name, 'Puducherry');
  assert.equal(districtAt(12.97, 77.59, districts), null); // Bengaluru, Karnataka
  assert.equal(districtAt(12.0, 81.5, districts), null); // the Bay of Bengal
});

test('alerts only on cells of at least 45 dBZ inside the region, strongest first', () => {
  const cells = alertCells(snap([cell(11.74, 78.96, 47), cell(12.97, 77.59, 58), cell(11.93, 79.83, 52), cell(10.8, 78.7, ALERT_DBZ - 1)]), districts);
  assert.deepEqual(cells.map(c => [c.places.over[0], c.dbz]), [['Puducherry', 52], ['Kallakurichi', 47]]);
});

test('posts when there are storms, not on stale or repeated pictures, and keeps quiet for an hour unless things get worse', () => {
  const s = snap([cell(11.74, 78.96, 48)]);
  const cells = alertCells(s, districts);
  assert.equal(decide(cells, s, {}, NOW).post, true);
  assert.equal(decide([], s, {}, NOW).post, false);
  assert.equal(decide(cells, snap(s.cells, 55), {}, NOW).post, false); // the radar is stale
  const after = stateAfterPost(cells, s, NOW - 20 * MIN);
  assert.equal(decide(cells, s, after, NOW).post, false); // the same picture
  const next = snap([cell(11.74, 78.96, 49)], 0);
  assert.equal(decide(alertCells(next, districts), next, after, NOW).post, false); // 20 min later, about the same
  const worse = snap([cell(11.74, 78.96, 54)], 0);
  assert.equal(decide(alertCells(worse, districts), worse, after, NOW).post, true); // +6 dBZ
  const spread = snap([cell(11.74, 78.96, 48), cell(13.08, 80.27, 46)], 0);
  assert.match(decide(alertCells(spread, districts), spread, after, NOW).reason, /Chennai/); // a new district
  const later = { ...snap([cell(11.74, 78.96, 48)], 0), radarTimeMs: NOW + COOLDOWN_MIN * MIN }; // a fresh picture an hour on
  assert.equal(decide(alertCells(later, districts), later, after, NOW + COOLDOWN_MIN * MIN).post, true); // the hour is over
});

test('writes a post that fits X, says where, how strong, where it goes and when, and that it is not an official warning', () => {
  const s = snap([cell(11.74, 78.96, 56, 22, 50), cell(11.93, 79.83, 50), cell(11.5, 79.5, 47)]);
  const text = composePost(alertCells(s, districts), s.radarTimeMs);
  assert.ok(xLength(text) <= 280, text);
  assert.match(text, /Severe thunderstorm over Kallakurichi, Puducherry/);
  assert.match(text, /Peak 56 dBZ · moving NE ~22 km\/h/);
  assert.match(text, /IMD radar 15:50 IST/);
  assert.match(text, /not an official warning/);
  const many = snap(districts.slice(0, 12).map(d => cell((d.box[1] + d.box[3]) / 2, (d.box[0] + d.box[2]) / 2, 50)));
  const long = composePost(alertCells(many, districts), many.radarTimeMs, { link: 'atmosradar.netlify.app' });
  assert.ok(xLength(long) <= 280, long);
  assert.match(altText(alertCells(s, districts), s.radarTimeMs), /IMD Doppler radar/);
  assert.equal(compass(350), 'N');
  assert.equal(compass(225), 'SW');
});

test('writes the Telegram caption: the same alert, with the live radar link, within Telegram\'s 1024 characters', () => {
  const s = snap([cell(11.74, 78.96, 51, 15, 90)]);
  const caption = composeTelegram(alertCells(s, districts), s.radarTimeMs);
  assert.match(caption, /Strong thunderstorms over Kallakurichi/);
  assert.match(caption, /moving E ~15 km\/h/);
  assert.match(caption, /Live radar: https:\/\/atmosradar\.netlify\.app$/);
  assert.ok(caption.length <= 1024);
  assert.equal(TELEGRAM_CHAT, '@tnweatheralerts');
});

test('sends the picture and caption to the channel through the Bot API, and explains a refusal', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  let seen = null;
  const ok = async (url, init) => {
    seen = { url, form: init.body };
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }) };
  };
  assert.equal(await sendTelegram('TOKEN', '@tnweatheralerts', png, 'storm!', ok), 42);
  assert.equal(seen.url, 'https://api.telegram.org/botTOKEN/sendPhoto');
  assert.equal(seen.form.get('chat_id'), '@tnweatheralerts');
  assert.equal(seen.form.get('caption'), 'storm!');
  const photo = seen.form.get('photo');
  assert.equal(photo.type, 'image/png');
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), png);
  const refused = async () => ({ ok: false, status: 403, json: async () => ({ ok: false, description: 'Forbidden: bot is not a member of the channel chat' }) });
  await assert.rejects(sendTelegram('TOKEN', '@tnweatheralerts', png, 'x', refused), /not a member of the channel/);
});

test('names the places right: the district under a storm, both sides of a border, off the coast, and where it is heading', () => {
  // over Kallakurichi town
  assert.equal(stormPlaces(cell(11.738, 78.962, 50, null, null), districts, land).over[0], 'Kallakurichi');

  // on the Viluppuram-Kallakurichi border (found by walking from one town to the other): a 12 km storm names both
  let border = null;
  for (let t = 0; t <= 1; t += 0.01) {
    const lat = 11.738 + (11.94 - 11.738) * t, lon = 78.962 + (79.49 - 78.962) * t;
    if (districtAt(lat, lon, districts)?.name === 'Viluppuram') { border = [lat, lon]; break; }
  }
  assert.ok(border);
  const straddling = stormPlaces(cell(border[0], border[1], 50, null, null, 12), districts, land);
  assert.ok(straddling.over.includes('Viluppuram') && straddling.over.includes('Kallakurichi'), straddling.over.join());

  // 12 km off the Cuddalore coast, over the sea
  const offshore = stormPlaces(cell(11.75, 79.88, 50, null, null, 4), districts, land);
  assert.deepEqual(offshore.over, []);
  assert.equal(offshore.near?.name, 'Cuddalore');
  assert.equal(offshore.near?.offshore, true);
  const s1 = snap([cell(11.75, 79.88, 50, null, null, 4)]);
  assert.match(composePost(alertCells(s1, districts, land), s1.radarTimeMs), /over|off the Cuddalore coast/);
  assert.match(describePlaces(alertCells(s1, districts, land)).where, /^off the Cuddalore coast$/);

  // 35 km out at sea east of Chennai, moving west at 40 km/h: not near enough to name, but it comes ashore within the hour
  const incoming = snap([cell(13.08, 80.6, 52, 40, 270, 5)]);
  const [c] = alertCells(incoming, districts, land);
  assert.ok(c, 'a storm heading into the region is alerted');
  assert.ok(c.places.towards.includes('Chennai'), c.places.towards.join());
  assert.match(composePost([c], incoming.radarTimeMs), /approaching Chennai/);
  assert.ok(!/Next hour: Chennai/.test(composePost([c], incoming.radarTimeMs)), 'named once');

  // a storm over Kallakurichi moving north-east names where it goes next, and not where it already is
  const moving = stormPlaces(cell(11.738, 78.962, 50, 40, 45), districts, land);
  assert.ok(moving.towards.length > 0);
  assert.ok(!moving.towards.includes('Kallakurichi'));

  // over Bengaluru, far outside the region and not heading in: nothing
  assert.deepEqual(alertCells(snap([cell(12.97, 77.59, 58, 10, 270)]), districts, land), []);
});

test('builds the Discord message: an embed with the alert, the colour of its strength, the radar picture and its time; no pings', () => {
  const s = snap([cell(11.738, 78.962, 55, 20, 45)]);
  const payload = discordPayload(alertCells(s, districts, land), s.radarTimeMs);
  const [embed] = payload.embeds;
  assert.match(embed.title, /^⛈️ Severe thunderstorm over Kallakurichi/);
  assert.match(embed.description, /Peak 55 dBZ · moving NE ~20 km\/h/);
  assert.match(embed.description, /not an official warning/);
  assert.match(embed.description, /\[Live radar\]\(https:\/\/atmosradar\.netlify\.app\)/);
  assert.equal(embed.image.url, 'attachment://radar.png');
  assert.equal(embed.timestamp, new Date(s.radarTimeMs).toISOString());
  assert.equal(embed.color, 0xe53935);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.ok(alertColor(46) !== alertColor(51) && alertColor(51) !== alertColor(56));
});

test('posts to the Discord webhook with the picture attached, waits for the message, and explains a refusal', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]);
  let seen = null;
  const ok = async (url, init) => {
    seen = { url, form: init.body };
    return { ok: true, json: async () => ({ id: '123' }) };
  };
  const hook = 'https://discord.com/api/webhooks/1/abc';
  assert.equal(await sendDiscord(hook, png, { embeds: [] }, ok), '123');
  assert.equal(seen.url, `${hook}?wait=true`);
  assert.deepEqual(JSON.parse(seen.form.get('payload_json')), { embeds: [] });
  const file = seen.form.get('files[0]');
  assert.equal(file.name, 'radar.png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  const refused = async () => ({ ok: false, status: 404, json: async () => ({ message: 'Unknown Webhook' }) });
  await assert.rejects(sendDiscord(hook, png, {}, refused), /Unknown Webhook/);
});

test('never cuts a post short: with many storms it names fewer places and drops the advice and hashtags first', () => {
  const s = snap([
    cell(11.80, 79.20, 53, 22, 55, 12), cell(11.75, 79.88, 48, 15, 270, 5), cell(13.08, 80.6, 50, 40, 270, 5),
    ...districts.slice(0, 15).map(d => cell((d.box[1] + d.box[3]) / 2, (d.box[0] + d.box[2]) / 2, 47, 30, 90)),
  ]);
  for (const link of ['', 'atmosradar.netlify.app']) {
    const text = composePost(alertCells(s, districts, land), s.radarTimeMs, { link });
    assert.ok(xLength(text) <= 280, text);
    assert.match(text, /not an official warning/);
    assert.match(text, /^⛈️ Strong thunderstorms over Kallakurichi/);
    assert.ok(!/#\w*$/.test(text) || /#TNWeather$/.test(text), 'hashtags whole or not at all');
  }
  // the coastal storm is named once, not again as a place it is heading to
  const coast = snap([cell(11.75, 79.88, 48, 15, 270, 5)]);
  const text = composePost(alertCells(coast, districts, land), coast.radarTimeMs);
  assert.equal(text.match(/Cuddalore/g).length, 1, text);
});
