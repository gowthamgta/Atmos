import { expect, test } from './fixtures';

test.describe('forecast & meteogram', () => {
  test('renders Rain accumulation (raintot) layer in mm with no errors', async ({ page, errors }) => {
    await page.goto('/#l=raintot');
    await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
    await page.waitForTimeout(2000);
    await expect(page.locator('body')).toContainText('mm');
    expect(errors).toEqual([]);
  });

  test('opens menu and shows forecast layers and models without errors', async ({ page, errors }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Menu/ }).click();
    await expect(page.locator('app-menu-panel')).toBeVisible();
    await expect(page.locator('app-menu-panel')).toContainText('Rain accumulation');
    await page.getByRole('tab', { name: 'Models' }).click();
    await expect(page.locator('app-menu-panel')).toContainText('Kralveth AI');
    expect(errors).toEqual([]);
  });
});
