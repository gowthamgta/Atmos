import { expect, openRadar, test, viewInUrl } from './fixtures';

test.describe('radar', () => {
  test('shows both radars with their printed scan times and no errors', async ({ page, errors }) => {
    await openRadar(page);
    const panel = page.locator('app-radar-panel');
    // the scan time read off Karaikal's picture (16:12:22 UTC = 21:42:22 IST), 17 minutes before the test clock
    await expect(panel.getByText(/09:42:22 PM IST/)).toBeVisible();
    await expect(panel.getByRole('button', { name: /Karaikal/ })).toContainText(/1[78]m/);
    expect(errors).toEqual([]);
  });

  test('turns one radar off and on without moving the map', async ({ page }) => {
    await openRadar(page);
    const view = viewInUrl(page);
    const chennai = page.locator('app-radar-panel').getByRole('button', { name: /Chennai/ });
    await chennai.click();
    await expect(chennai).toHaveAttribute('aria-pressed', 'false');
    await expect(chennai).toContainText('off');
    await chennai.click();
    await expect(chennai).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(1000); // a map that was going to move has started by now
    expect(viewInUrl(page)).toBe(view);
  });

  test('turns both radars off, and remembers it after a reload', async ({ page }) => {
    await openRadar(page);
    const panel = page.locator('app-radar-panel');
    const karaikal = panel.getByRole('button', { name: /Karaikal/ });
    const chennai = panel.getByRole('button', { name: /Chennai/ });
    await karaikal.click();
    await chennai.click();
    // the two radars the saved pictures are of are off (every other radar is answered 404)
    await expect(karaikal).toHaveAttribute('aria-pressed', 'false');
    await expect(chennai).toHaveAttribute('aria-pressed', 'false');
    await page.reload();
    await expect(panel.locator('section')).toBeVisible(); // the panel loads when the browser is idle
    const more = panel.getByRole('button', { name: 'Show more' });
    if (await more.isVisible()) await more.click();
    await expect(karaikal).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    await expect(chennai).toHaveAttribute('aria-pressed', 'false');
    // turn them back on so the saved choice does not leak into a later visit
    await panel.getByRole('button', { name: /Karaikal/ }).click();
    await panel.getByRole('button', { name: /Chennai/ }).click();
    await expect(panel.getByText(/Radars online/)).toBeVisible();
  });

  test('reads the beam height of each radar under the pointer', async ({ page, isMobile }) => {
    await openRadar(page);
    const map = page.locator('canvas.maplibregl-canvas');
    const box = (await map.boundingBox())!;
    // a point right of the middle: over land between the two radars at this view
    const x = box.x + box.width * 0.7;
    const y = box.y + box.height * 0.45;
    if (isMobile) await page.mouse.click(x, y);
    else await page.mouse.move(x, y);
    const tooltip = page.locator('.radar-hover-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText(/Karaikal \d+ km/);
    await expect(tooltip).toContainText(/\d+\.\d km up/);
  });
});
