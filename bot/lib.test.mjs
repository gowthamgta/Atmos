import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ALERT_DBZ, COOLDOWN_MIN, TELEGRAM_CHAT, alertCells, altText, compass, composePost, composeTelegram, decide, districtAt, regionDistricts,
  sendTelegram, stateAfterPost, xLength,
} from './lib.mjs';

const districts = regionDistricts(JSON.parse(readFileSync(new URL('../public/data/south-india-districts.geojson', import.meta.url), 'utf8')));
const NOW = Date.UTC(2026, 9, 19, 10, 30);
const MIN = 60_000;
const cell = (lat, lon, dbz, speedKmh = 20, towardsDeg = 45) => ({ lat, lon, dbz, radiusKm: 8, speedKmh, towardsDeg });
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
  assert.deepEqual(cells.map(c => [c.district.name, c.dbz]), [['Puducherry', 52], ['Kallakurichi', 47]]);
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
  const long = composePost(alertCells(many, districts).filter(c => c.district), many.radarTimeMs, { link: 'atmosradar.netlify.app' });
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
