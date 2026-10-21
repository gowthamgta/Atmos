import { expect, test } from './fixtures';

test.describe('the app', () => {
  test('opens on the forecast map with no errors', async ({ page, errors }) => {
    await page.goto('/');
    await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
    await expect(page.getByRole('button', { name: /Menu/ })).toBeVisible();
    await page.waitForTimeout(3000); // the panels load when the browser is idle
    expect(errors).toEqual([]);
  });

  test('switches between the radar and the satellite', async ({ page }) => {
    await page.goto('/#l=radar');
    await expect(page.locator('app-radar-panel section')).toBeVisible();
    await page.goto('/#l=satellite');
    await page.reload();
    await expect(page.locator('app-satellite-panel')).toContainText('Meteosat');
    await expect(page.locator('app-radar-panel section')).toHaveCount(0);
  });

  test('is installable: manifest and icon are served', async ({ request }) => {
    const manifest = await (await request.get('/manifest.webmanifest')).json();
    expect(manifest.name).toBe('AtmosIQ');
    expect((await request.get('/icon.svg')).ok()).toBe(true);
  });
});
