// The radar sampler: opens the live radar of Kralveth Weather in a headless browser and keeps the radar (and its 30 and 60 minute nowcast) over the
// Tamil Nadu gauge cells, for the daily verification (pipeline/verify_radar.py). It posts nothing anywhere: the nowcast bot that posted
// storms to Telegram, Discord and X was removed (the owner, 1 Nov 2026). Run by .github/workflows/nowcast.yml; see README.md in this folder.
//
// Environment:
//   SITE_URL       the app (default https://atmosradar.netlify.app)
//   SAMPLES_FILE   where the samples are kept (default bot/samples/radar-samples.json; kept between runs by the workflow's cache)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { CELL_HALF_DEG, GAUGE_POINTS, appendSamples } from './samples.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = (process.env.SITE_URL || 'https://atmosradar.netlify.app').replace(/\/$/, '');
const SAMPLES_FILE = process.env.SAMPLES_FILE || join(HERE, 'samples', 'radar-samples.json');
/** Tamil Nadu and Puducherry fill the picture at this view. */
const VIEW = { lat: 10.9, lon: 78.6, zoom: 6.35 };
/** How long to wait for the radar and its last-hour loop (the nowcast moves the rain by it) before using what there is. */
const WAIT_MS = 150_000;

const log = (...a) => console.log(`[radar samples ${new Date().toISOString()}]`, ...a);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** The live radar over the gauge cells (null when the app has no picture or no sampler). */
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
    const started = Date.now();
    let snapshot = null;
    while (Date.now() - started < WAIT_MS) {
      snapshot = await page.evaluate(() => window.__atmosNowcast ?? null);
      if (snapshot && snapshot.loopLoaded) break;
      await page.waitForTimeout(3000);
    }
    if (!snapshot) throw new Error(`the app published no radar picture within ${WAIT_MS / 1000} s (IMD radar down?)`);
    log(`radar ${new Date(snapshot.radarTimeMs).toISOString()}, loop ${snapshot.loopLoaded}`);
    return page.evaluate(([p, h]) => window.__atmosSample?.(p, h) ?? null, [GAUGE_POINTS, CELL_HALF_DEG]);
  } finally {
    await browser.close();
  }
}

async function main() {
  const samples = await capture();
  if (!samples) {
    log('the app gave no radar samples: none kept');
    return;
  }
  const store = appendSamples(await readJson(SAMPLES_FILE, null), samples, Date.now());
  await mkdir(dirname(SAMPLES_FILE), { recursive: true });
  await writeFile(SAMPLES_FILE, JSON.stringify(store));
  log(`radar over ${GAUGE_POINTS.length} gauge cells kept (${store.records.length} looks in the store)`);
}

main().catch(e => {
  console.error(e);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=Radar samples failed::${String(e?.message ?? e).replace(/\r?\n/g, ' ')}`);
  process.exitCode = 1;
});
