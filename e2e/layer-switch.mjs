// How fast the forecast layers switch, on the production build with the real GPU: each layer is picked (through the address, as the menu
// does) and timed from the pick to the moment its data is on the GPU (the 'forecast-layer-shown' mark) and the next frame drawn. Then rapid
// switching, panning and zooming are run while the frame rate is measured, and the memory in use is read.
//
//   npx ng build && node scripts/preview.js        (in another terminal: the build on http://localhost:8080)
//   node e2e/layer-switch.mjs [--phone]            (prints the report and writes e2e/layer-switch-report.json)
import { chromium, devices } from 'playwright';
import { writeFileSync } from 'node:fs';

const SITE = process.env.SITE_URL || 'http://localhost:8080';
const PHONE = process.argv.includes('--phone');
const LABELS = {
  temp: 'Temperature', feels: 'Feels like', dew: 'Dew point', wind: 'Wind', gust: 'Wind gusts', humidity: 'Humidity', rain: 'Rain',
  tcwv: 'Atmospheric moisture', vis: 'Visibility', pressure: 'Pressure', li: 'Lifted index', cin: 'Convective inhibition',
  cape: 'Thunderstorm energy', tmin24: 'Lowest, next 24 h', tmax24: 'Highest, next 24 h',
};
const LAYERS = Object.keys(LABELS);

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ ...(PHONE ? devices['Pixel 7'] : { viewport: { width: 1366, height: 800 } }), serviceWorkers: 'block' });
const page = await context.newPage();
if (PHONE) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}
await page.goto(`${SITE}/#l=temp&o=particles`, { waitUntil: 'domcontentloaded' });
await page.locator('canvas.maplibregl-canvas').waitFor({ timeout: 60_000 });
await page.waitForFunction(() => performance.getEntriesByName('forecast-layer-shown').length > 0, null, { timeout: 60_000 });
await page.waitForTimeout(25_000); // the other layers' pictures come in the background

/** The menu open (its layer buttons are what a visitor clicks). */
async function openMenu() {
  if (await page.locator('#menu-panel').isVisible().catch(() => false)) return;
  await page.getByRole('button', { name: /Menu/ }).first().click();
  await page.locator('#menu-panel').waitFor({ timeout: 10_000 });
}

/** Clicks a layer in the menu and returns ms from the click to its data on the GPU and the next frame drawn (-1: it never came). */
async function switchTo(id) {
  await openMenu();
  return page.evaluate(([id, label]) => new Promise(resolve => {
    const button = [...document.querySelectorAll('#menu-panel button')].find(b => b.querySelector('.l-name')?.textContent?.trim() === label);
    if (!button) return resolve(-2);
    const before = performance.getEntriesByName('forecast-layer-shown').length;
    const t0 = performance.now();
    button.click();
    const poll = () => {
      const marks = performance.getEntriesByName('forecast-layer-shown');
      const hit = marks.slice(before).find(m => m.detail === id);
      if (hit) requestAnimationFrame(() => resolve(performance.now() - t0));
      else if (performance.now() - t0 > 10_000) resolve(-1);
      else requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }), [id, LABELS[id]]);
}

/** Frame rate over `ms` while `act` runs (median and worst 1%), from the gaps between animation frames. */
async function fpsDuring(ms, act) {
  await page.evaluate(ms => {
    window.__gaps = [];
    let last = 0;
    const end = performance.now() + ms;
    const tick = now => {
      if (last) window.__gaps.push(now - last);
      last = now;
      if (now < end) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ms);
  await act();
  await page.waitForTimeout(ms + 200);
  return page.evaluate(() => {
    const g = [...window.__gaps].sort((a, b) => a - b);
    if (g.length < 5) return null;
    return { medianFps: Math.round(1000 / g[Math.floor(g.length / 2)]), worst1pctFps: Math.round(1000 / g[Math.floor(g.length * 0.99)]), frames: g.length };
  });
}

const switches = {};
for (const id of LAYERS) switches[id] = Math.round(await switchTo(id));
const times = Object.values(switches).filter(t => t >= 0).sort((a, b) => a - b);
const rapid = await fpsDuring(4000, async () => {
  for (let i = 0; i < 12; i++) {
    await switchTo(LAYERS[i % LAYERS.length]);
    await page.waitForTimeout(120);
  }
});
await page.keyboard.press('Escape'); // the menu closed: the map is panned and zoomed in full
await page.waitForTimeout(500);
const box = await page.locator('canvas.maplibregl-canvas').boundingBox();
const pan = await fpsDuring(4000, async () => {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < 40; i++) await page.mouse.move(cx + Math.sin(i / 6) * 200, cy + Math.cos(i / 6) * 120, { steps: 2 });
  await page.mouse.up();
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, i % 2 ? 300 : -300); await page.waitForTimeout(250); }
});
const idle = await fpsDuring(3000, async () => {});
const heapMb = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null));
const gpu = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const i = gl?.getExtension('WEBGL_debug_renderer_info'); return i ? String(gl.getParameter(i.UNMASKED_RENDERER_WEBGL)) : ''; });

const report = {
  device: PHONE ? 'Pixel 7 screen, CPU 4x slower' : 'desktop 1366x800', gpu,
  switchMs: switches,
  switchMedianMs: times[Math.floor(times.length / 2)], switchWorstMs: times.at(-1), under30ms: times.filter(t => t <= 30).length + '/' + times.length,
  rapidSwitchingFps: rapid, panZoomFps: pan, idleWithWindFps: idle, heapMb,
};
console.log(JSON.stringify(report, null, 2));
writeFileSync(new URL('./layer-switch-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
await browser.close();
