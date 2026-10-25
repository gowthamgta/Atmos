import { expect, openRadar, test, viewInUrl } from './fixtures';

test.describe('radar', () => {
  test('shows radar panel with legend and no errors', async ({ page, errors }) => {
    await openRadar(page);
    const panel = page.locator('app-radar-panel');
    await expect(panel.locator('.legend')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('reads the beam height of each radar on click, and dismisses on next click', async ({ page }) => {
    await openRadar(page);
    const map = page.locator('canvas.maplibregl-canvas');
    const box = (await map.boundingBox())!;
    // a point right of the middle: over land between the two radars at this view
    const x = box.x + box.width * 0.7;
    const y = box.y + box.height * 0.45;
    await page.mouse.click(x, y);
    const tooltip = page.locator('.radar-hover-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText(/Karaikal \d+ km/);
    await expect(tooltip).toContainText(/\d+\.\d km up/);

    // Clicking again dismisses the tooltip
    await page.mouse.click(x, y);
    await expect(tooltip).not.toBeVisible();
  });
});
