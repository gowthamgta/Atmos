import { test as base, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TESTDATA = join(__dirname, '..', 'src', 'app', 'core', 'services', 'testdata');

/** The saved IMD pictures served for each radar's column maximum (their printed scan times: 16:12:22 and 16:10 UTC on 18 Oct 2026). */
const RADAR_PICTURES: Record<string, string> = {
  'caz_kkl.gif': 'karaikal-caz-stamp.gif',
  'caz_cni.gif': 'chennai-caz-stamp.gif',
};
/** The browser's clock in the tests: shortly after those scans, so the pictures are fresh (IMD copies them about ten minutes after). */
export const TEST_NOW = new Date('2026-10-18T16:30:00Z');
const COPIED_AT = new Date('2026-10-18T16:24:00Z').toUTCString();

/** Serves the saved radar pictures, answers 404 for the other radar files, and keeps live outside feeds (satellite, lightning) out. */
async function routeData(page: Page): Promise<void> {
  await page.route(/\/(imd-radar\/|\.netlify\/functions\/radar|Radar\/)/, async route => {
    const url = new URL(route.request().url());
    const file = (url.searchParams.get('file') ?? url.pathname.split('/').pop() ?? '').replace(/^.*\//, '');
    const saved = RADAR_PICTURES[file];
    if (!saved) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      status: 200,
      body: readFileSync(join(TESTDATA, saved)),
      headers: { 'content-type': 'image/gif', 'last-modified': COPIED_AT, 'access-control-allow-origin': '*' },
    });
  });
  await page.route(/view\.eumetsat\.int|ildn|\.netlify\/functions\/lightning/, route => route.abort());
}

export const test = base.extend<{ errors: string[]; savedData: void }>({
  // every test sees the saved radar pictures at the time they were copied (before, only the tests that asked for `errors` did, and the
  // others read IMD's live radar: whatever it showed decided whether they passed)
  savedData: [
    async ({ page }, use) => {
      await page.clock.install({ time: TEST_NOW });
      await routeData(page);
      await use();
    },
    { auto: true },
  ],
  // every page error and console error of a test, checked by the tests that want none
  errors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => {
      if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push(m.text());
    });
    await use(errors);
  },
});

export { expect };

/** Opens the map with the radar on, at a fixed view, and waits for both radars' chips to be in. */
export async function openRadar(page: Page, view = '11.8,79.6,6.6'): Promise<void> {
  await page.goto(`/#l=radar&c=${view}`);
  await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
  const panel = page.locator('app-radar-panel');
  await expect(panel.locator('section')).toBeVisible(); // the panel loads when the browser is idle
  // phones start with the compact panel: open it
  const more = panel.getByRole('button', { name: 'Show more' });
  if (await more.isVisible()) await more.click();
  await expect(panel.locator('.legend')).toBeVisible({ timeout: 30_000 });
}

/** The map's centre and zoom as written in the address (c=lat,lng,zoom). */
export function viewInUrl(page: Page): string | null {
  return new URL(page.url()).hash.match(/c=([^&]+)/)?.[1] ?? null;
}
