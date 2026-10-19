// The nowcast bot: opens the live radar of AtmosIQ in a headless browser, reads the storm cells the app finds on it, and when there are
// storms in Tamil Nadu or Puducherry posts the radar picture with a short alert to X. Run every ten minutes by
// .github/workflows/nowcast.yml; see README.md in this folder.
//
// Environment:
//   SITE_URL       the app (default https://atmosradar.netlify.app)
//   DRY_RUN        "1" (the default when the X keys are missing): decide and write bot/out/, but do not post
//   FORCE          "1": post (or dry-run) even when there is no storm or the last post is recent, to try the whole chain
//   STATE_FILE     where the last post is remembered (default bot/state/state.json; kept between runs by the workflow's cache)
//   INCLUDE_LINK   "1": add the app's address to the post (X charges a post with a link more)
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET   the X app's keys and the account's access token (OAuth 1.0a)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { alertCells, altText, composePost, decide, regionDistricts, stateAfterPost } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = (process.env.SITE_URL || 'https://atmosradar.netlify.app').replace(/\/$/, '');
const STATE_FILE = process.env.STATE_FILE || join(HERE, 'state', 'state.json');
const OUT = join(HERE, 'out');
const KEYS = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'];
const haveKeys = KEYS.every(k => process.env[k]);
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
    return { snapshot, png };
  } finally {
    await browser.close();
  }
}

async function post(text, png, alt) {
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
  log(DRY_RUN ? `dry run${haveKeys ? '' : ' (no X keys set)'}: nothing will be posted` : 'live: storms will be posted to X');
  const districts = regionDistricts(JSON.parse(await readFile(join(HERE, '..', 'public', 'data', 'south-india-districts.geojson'), 'utf8')));
  const state = await readJson(STATE_FILE, {});
  const now = Date.now();

  const { snapshot, png } = await capture();
  await writeFile(join(OUT, 'radar.png'), png);
  const cells = alertCells(snapshot, districts);
  let decision = decide(cells, snapshot, state, now);
  if (FORCE && !decision.post) decision = { post: true, reason: `forced (would not post: ${decision.reason})` };
  log(decision.post ? 'post:' : 'no post:', decision.reason);

  // a forced run with no storm still writes a sample post, from the strongest cell anywhere on the radar
  const shown = cells.length > 0 ? cells : snapshot.cells.slice().sort((a, b) => b.dbz - a.dbz).slice(0, 1).map(c => ({ ...c, district: { name: 'Tamil Nadu' } }));
  const text = shown.length > 0 ? composePost(shown, snapshot.radarTimeMs, { link: process.env.INCLUDE_LINK === '1' ? SITE.replace(/^https:\/\//, '') : '' }) : '';
  const alt = shown.length > 0 ? altText(shown, snapshot.radarTimeMs) : '';
  await writeFile(join(OUT, 'decision.json'), JSON.stringify({ decision, dryRun: DRY_RUN, radarTimeMs: snapshot.radarTimeMs, alertCells: cells, allCells: snapshot.cells, state, text, alt }, null, 2));
  if (text) await writeFile(join(OUT, 'post.txt'), `${text}\n\n--- alt text ---\n${alt}\n`);

  if (!decision.post || !text) return;
  if (DRY_RUN) {
    log('dry run, the post would be:\n' + text);
    return;
  }
  const id = await post(text, png, alt);
  log(`posted https://x.com/i/web/status/${id}`);
  if (cells.length > 0) {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(stateAfterPost(cells, snapshot, now), null, 2));
  }
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
