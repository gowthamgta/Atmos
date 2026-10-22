// How the production build runs on a mid-range Android phone (about the owner's OnePlus Nord CE3 Lite, a Snapdragon 695): Chrome emulating
// a Pixel 7 screen with the CPU slowed 4x and a fast 4G network, on the real data. For each view (forecast with wind particles, radar,
// satellite playing) it measures the time to the map, the main-thread tasks over 50 ms, the memory in use and the frame rate.
//
//   npx ng build && node scripts/preview.js        (in another terminal: the build on http://localhost:8080)
//   node e2e/perf.mjs                              (prints the report and writes e2e/perf-report.json)
import { chromium, devices } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const SITE = process.env.SITE_URL || 'http://localhost:8080';
const CPU_SLOWDOWN = 4;
const NETWORK = { offline: false, latency: 150, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 }; // fast 4G

const VIEWS = [
  { name: 'forecast (temperature, wind particles)', hash: '#l=temp&o=particles,relief', settleMs: 15_000 },
  { name: 'radar', hash: '#l=radar', settleMs: 25_000 },
  { name: 'satellite (playing)', hash: '#l=satellite', settleMs: 20_000, play: true },
];

async function measure(browser, view) {
  const context = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block' });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', NETWORK);
  await page.addInitScript(() => {
    window.__perf = { longTasks: [] };
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) window.__perf.longTasks.push(Math.round(e.duration));
    }).observe({ type: 'longtask', buffered: true });
  });
  const t0 = Date.now();
  await page.goto(`${SITE}/${view.hash}`, { waitUntil: 'domcontentloaded' });
  await page.locator('canvas.maplibregl-canvas').waitFor({ timeout: 60_000 });
  const mapMs = Date.now() - t0;
  if (view.play) {
    const play = page.getByRole('button', { name: /Play loop/ });
    await play.waitFor({ timeout: 30_000 }).catch(() => {});
    if (await play.isVisible().catch(() => false)) await play.click();
  }
  await page.waitForTimeout(view.settleMs);
  // frames drawn over 5 seconds, while the view runs (particles moving, the loop playing)
  const fps = await page.evaluate(
    () =>
      new Promise(resolve => {
        let n = 0;
        const start = performance.now();
        const tick = () => {
          n++;
          if (performance.now() - start < 5000) requestAnimationFrame(tick);
          else resolve(Math.round((n / (performance.now() - start)) * 1000));
        };
        requestAnimationFrame(tick);
      }),
  );
  const { longTasks } = await page.evaluate(() => window.__perf);
  const heap = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
  const transfer = await page.evaluate(() => Math.round(performance.getEntriesByType('resource').reduce((s, e) => s + (e.transferSize || 0), 0) / 1024));
  await context.close();
  return {
    view: view.name,
    mapMs,
    longTasks: longTasks.length,
    longTaskMs: longTasks.reduce((a, b) => a + b, 0),
    worstTaskMs: longTasks.length ? Math.max(...longTasks) : 0,
    fps,
    heapMb: heap,
    downloadedKb: transfer,
  };
}

// the machine's real GPU through ANGLE (left to itself a headless browser draws WebGL in software, on the CPU the test slows down: that
// would measure the emulation, not the app). A phone's GPU is slower than most desktops', so the frame rates here are an upper bound.
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist'] });
const results = [];
for (const view of VIEWS) {
  try {
    results.push(await measure(browser, view));
  } catch (e) {
    results.push({ view: view.name, error: String(e).slice(0, 200) });
  }
}
await browser.close();
const report = { at: new Date().toISOString(), site: SITE, device: `Pixel 7 screen, CPU ${CPU_SLOWDOWN}x slower, fast 4G`, results };
writeFileSync(new URL('./perf-report.json', import.meta.url), JSON.stringify(report, null, 2));
console.table(results);
