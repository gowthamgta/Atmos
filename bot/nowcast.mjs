// The nowcast bot: opens the live radar of AtmosIQ in a headless browser, reads the storm cells the app finds on it, and when there are
// storms in Tamil Nadu or Puducherry posts the radar picture with a short alert to Telegram, Discord and X (each when its keys are set). Run
// every ten minutes by .github/workflows/nowcast.yml; see README.md in this folder.
//
// Environment:
//   SITE_URL       the app (default https://atmosradar.netlify.app)
//   DRY_RUN        "1" (the default when no keys are set at all): decide and write bot/out/, but do not post
//   FORCE          "1": post (or dry-run) even when there is no storm or the last post is recent, to try the whole chain
//   STATE_FILE     where the last post is remembered (default bot/state/state.json; kept between runs by the workflow's cache)
//   INCLUDE_LINK   "1": add the app's address to the post (X charges a post with a link more)
//   TELEGRAM_BOT_TOKEN  the Telegram bot's token (from @BotFather); TELEGRAM_CHAT_ID the channel (default @tnweatheralerts)
//   DISCORD_WEBHOOK_URL a Discord channel's webhook (Server settings → Integrations → Webhooks)
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET   the X app's keys and the account's access token (OAuth 1.0a)
//   SAMPLES_FILE   where the radar over the gauge cells is kept for the daily verification (default bot/samples/radar-samples.json)
//   ALERT_PLACES   the owner's places for their own rain alerts, "Kallakurichi:11.74,78.96;Chennai:13.08,80.27"
//   TELEGRAM_ALERT_CHAT_ID  the owner's own Telegram chat for those alerts (nothing is sent without it)
//   PAIRS_DIR      where the satellite-against-radar pairs are kept for learning the synthetic radar (default bot/pairs-out; the workflow
//                  points it at its checkout of the rain-pairs branch)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  TELEGRAM_CHAT, alertCells, altText, composePost, composeTelegram, decide, discordPayload, regionDistricts, sendDiscord, sendTelegram, stateAfterPost,
} from './lib.mjs';
import { CELL_HALF_DEG, GAUGE_POINTS, PLACE_HALF_DEG, appendSamples, parsePlaces, placeAlert } from './samples.mjs';
import { savePairs } from './pairs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = (process.env.SITE_URL || 'https://atmosradar.netlify.app').replace(/\/$/, '');
const STATE_FILE = process.env.STATE_FILE || join(HERE, 'state', 'state.json');
const OUT = join(HERE, 'out');
const SAMPLES_FILE = process.env.SAMPLES_FILE || join(HERE, 'samples', 'radar-samples.json');
const PAIRS_DIR = process.env.PAIRS_DIR || join(HERE, 'pairs-out');
/** How long the app may take to pair the satellite with the radar (a worker builds them) before the look goes on without them. */
const PAIRS_WAIT_MS = 120_000;
const PLACES = parsePlaces(process.env.ALERT_PLACES);
const ALERT_CHAT = process.env.TELEGRAM_ALERT_CHAT_ID || '';
const X_KEYS = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'];
const haveX = X_KEYS.every(k => process.env[k]);
const haveTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN);
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || TELEGRAM_CHAT;
const haveDiscord = Boolean(process.env.DISCORD_WEBHOOK_URL);
const haveKeys = haveX || haveTelegram || haveDiscord;
const DRY_RUN = process.env.DRY_RUN === '1' || !haveKeys;
const FORCE = process.env.FORCE === '1';
/** Tamil Nadu and Puducherry fill the picture at this view. */
const VIEW = { lat: 10.9, lon: 78.6, zoom: 6.35 };
/** How long to wait for the radar and its last-hour loop (the motion of the storms) before using what there is. */
const WAIT_MS = 150_000;

const log = (...a) => console.log(`[nowcast ${new Date().toISOString()}]`, ...a);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** The live radar's storm cells and a screenshot of the radar over the region. */
async function capture() {
  const browser = await chromium.launch({
    // a GitHub runner has no GPU: WebGL through SwiftShader
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1200 }, deviceScaleFactor: 1 });
    page.on('pageerror', e => log('page error:', e.message));
    const url = `${SITE}/#l=radar&c=${VIEW.lat},${VIEW.lon},${VIEW.zoom}&bot=1`;
    log('opening', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // the app publishes the cells of the live picture each time it works them out; wait for the loop (motion from the radar) if it comes
    const started = Date.now();
    let snapshot = null;
    while (Date.now() - started < WAIT_MS) {
      snapshot = await page.evaluate(() => window.__atmosNowcast ?? null);
      if (snapshot && snapshot.loopLoaded) break;
      await page.waitForTimeout(3000);
    }
    if (!snapshot) throw new Error(`the app published no radar picture within ${WAIT_MS / 1000} s (IMD radar down?)`);
    await page.waitForTimeout(4000); // the storm cones and the picture settle on the map
    const png = await page.screenshot({ type: 'png' });
    log(`radar ${new Date(snapshot.radarTimeMs).toISOString()}, ${snapshot.cells.length} cells, motion from ${snapshot.motionSource}, loop ${snapshot.loopLoaded}`);
    // the radar over the gauge cells and the owner's places (an app without the sampler gives null: nothing is kept)
    const sample = (points, half) => page.evaluate(([p, h]) => window.__atmosSample?.(p, h) ?? null, [points, half]);
    const samples = await sample(GAUGE_POINTS, CELL_HALF_DEG);
    const placeSamples = PLACES.length ? await sample(PLACES.map(p => [p.lat, p.lon]), PLACE_HALF_DEG) : null;
    // the newest satellite frame against the radar at its time (an app without them, or one that takes too long, gives null)
    const pairs = await page
      .evaluate(ms => Promise.race([Promise.resolve(window.__atmosRainPairs?.() ?? null), new Promise(r => setTimeout(() => r(null), ms))]), PAIRS_WAIT_MS)
      .catch(e => {
        log('no pairs:', e.message);
        return null;
      });
    return { snapshot, png, samples, placeSamples, pairs };
  } finally {
    await browser.close();
  }
}

async function postToX(text, png, alt) {
  const { TwitterApi } = await import('twitter-api-v2');
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });
  const mediaId = await client.v2.uploadMedia(png, { media_type: 'image/png', media_category: 'tweet_image' });
  try {
    await client.v2.createMediaMetadata(mediaId, { alt_text: { text: alt } });
  } catch (e) {
    log('alt text not set:', e.message); // the post goes out without it
  }
  const res = await client.v2.tweet({ text, media: { media_ids: [mediaId] } });
  return res.data.id;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const outlets = [haveTelegram && `Telegram ${TELEGRAM_CHAT_ID}`, haveDiscord && 'Discord', haveX && 'X'].filter(Boolean).join(', ');
  log(DRY_RUN ? `dry run${haveKeys ? '' : ' (no keys set)'}: nothing will be posted` : `live: storms will be posted to ${outlets}`);
  const boundaries = JSON.parse(await readFile(join(HERE, '..', 'public', 'data', 'south-india-districts.geojson'), 'utf8'));
  const districts = regionDistricts(boundaries);
  const land = regionDistricts(boundaries, [...new Set(boundaries.features.map(f => f.properties?.state).filter(Boolean))]); // every state: sea or land
  const state = await readJson(STATE_FILE, {});
  const now = Date.now();

  const { snapshot, png, samples, placeSamples, pairs } = await capture();
  await writeFile(join(OUT, 'radar.png'), png);
  try {
    const file = await savePairs(PAIRS_DIR, pairs);
    if (pairs) log(`satellite frame ${new Date(pairs.satTimeMs).toISOString()} against radar ${new Date(pairs.radarTimeMs).toISOString()}: ${pairs.rows} pairs (${pairs.counts?.rainy ?? 0} rainy pixels seen), ${file ? 'kept' : 'not kept (kept already, or too far apart in time)'}`);
    else log('no satellite-against-radar pairs this look');
  } catch (e) {
    log('pairs not kept:', e.message);
  }
  if (samples) {
    const store = appendSamples(await readJson(SAMPLES_FILE, null), samples, now);
    await mkdir(dirname(SAMPLES_FILE), { recursive: true });
    await writeFile(SAMPLES_FILE, JSON.stringify(store));
    log(`radar over ${GAUGE_POINTS.length} gauge cells kept (${store.records.length} looks in the store)`);
  } else {
    log('the app gave no radar samples (an older version of it?): none kept');
  }
  await alertPlaces(placeSamples, snapshot, png, state, now);
  const cells = alertCells(snapshot, districts, land);
  let decision = decide(cells, snapshot, state, now);
  if (FORCE && !decision.post) decision = { post: true, reason: `forced (would not post: ${decision.reason})` };
  log(decision.post ? 'post:' : 'no post:', decision.reason);

  // a forced run with no storm still writes a sample post, from the strongest cell anywhere on the radar
  const shown = cells.length > 0 ? cells : snapshot.cells.slice().sort((a, b) => b.dbz - a.dbz).slice(0, 1).map(c => ({ ...c, places: { over: ['Tamil Nadu (test post)'], near: null, towards: [] } }));
  const text = shown.length > 0 ? composePost(shown, snapshot.radarTimeMs, { link: process.env.INCLUDE_LINK === '1' ? SITE.replace(/^https:\/\//, '') : '' }) : '';
  const alt = shown.length > 0 ? altText(shown, snapshot.radarTimeMs) : '';
  const caption = shown.length > 0 ? composeTelegram(shown, snapshot.radarTimeMs, SITE) : '';
  const discord = shown.length > 0 ? discordPayload(shown, snapshot.radarTimeMs, SITE) : null;
  await writeFile(join(OUT, 'decision.json'), JSON.stringify({ decision, dryRun: DRY_RUN, radarTimeMs: snapshot.radarTimeMs, alertCells: cells, allCells: snapshot.cells, state, text, alt }, null, 2));
  if (text) await writeFile(join(OUT, 'post.txt'), `--- X ---\n${text}\n\n--- alt text ---\n${alt}\n\n--- Telegram (${TELEGRAM_CHAT_ID}) ---\n${caption}\n\n--- Discord ---\n${JSON.stringify(discord, null, 2)}\n`);

  if (!decision.post || !text) return;
  if (DRY_RUN) {
    log('dry run, the post would be:\n' + caption);
    return;
  }
  // each outlet on its own: one failing does not stop the other, and the run is marked failed so it shows in Actions
  let posted = false;
  if (haveTelegram) {
    try {
      const id = await sendTelegram(process.env.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, png, caption);
      log(`posted to Telegram ${TELEGRAM_CHAT_ID} (message ${id})`);
      posted = true;
    } catch (e) {
      log(`Telegram post to ${TELEGRAM_CHAT_ID} failed: ${e.message}`);
      process.exitCode = 1;
    }
  }
  if (haveDiscord) {
    try {
      const id = await sendDiscord(process.env.DISCORD_WEBHOOK_URL, png, discord);
      log(`posted to Discord (message ${id})`);
      posted = true;
    } catch (e) {
      log(`Discord post failed: ${e.message}`);
      process.exitCode = 1;
    }
  }
  if (haveX) {
    try {
      const id = await postToX(text, png, alt);
      log(`posted https://x.com/i/web/status/${id}`);
      posted = true;
    } catch (e) {
      log('X refused the post:', e.message);
      process.exitCode = 1;
    }
  }
  // remembered once anything went out, so the storm is not posted again ten minutes later
  if (posted && cells.length > 0) {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    const latest = await readJson(STATE_FILE, {});
    await writeFile(STATE_FILE, JSON.stringify({ ...stateAfterPost(cells, snapshot, now), placeAlerts: latest.placeAlerts ?? state.placeAlerts }, null, 2));
  }
}

/** The owner's own alerts: rain about to reach one of their places, to their Telegram chat (once in a while per place; see samples.mjs). */
async function alertPlaces(placeSamples, snapshot, png, state, now) {
  if (!placeSamples || PLACES.length === 0) return;
  const sent = { ...(state.placeAlerts ?? {}) };
  let changed = false;
  for (const [i, place] of PLACES.entries()) {
    const box = { live: placeSamples.live[i], n30: placeSamples.n30[i], n60: placeSamples.n60[i] };
    const text = placeAlert(place, box, snapshot.radarTimeMs, now, sent[place.name]);
    if (!text) continue;
    if (DRY_RUN || !haveTelegram || !ALERT_CHAT) {
      log(`place alert (not sent: ${DRY_RUN ? 'dry run' : 'no TELEGRAM_ALERT_CHAT_ID or bot token'}): ${text}`);
      continue;
    }
    try {
      await sendTelegram(process.env.TELEGRAM_BOT_TOKEN, ALERT_CHAT, png, text);
      log(`place alert sent for ${place.name}`);
      sent[place.name] = now;
      changed = true;
    } catch (e) {
      log(`place alert for ${place.name} failed: ${e.message}`);
      process.exitCode = 1;
    }
  }
  if (changed) {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    const latest = await readJson(STATE_FILE, {});
    await writeFile(STATE_FILE, JSON.stringify({ ...latest, placeAlerts: sent }, null, 2));
  }
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
