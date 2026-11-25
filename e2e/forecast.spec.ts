import { expect, test } from './fixtures';

test.describe('forecast & meteogram', () => {
  test('renders Total Precipitable Water (tcwv) layer in mm with no errors', async ({ page, errors }) => {
    await page.goto('/#l=tcwv');
    await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
    await page.waitForTimeout(2000);
    await expect(page.locator('body')).toContainText('mm');
    expect(errors).toEqual([]);
  });

  test('opens menu and shows forecast layers and models without errors', async ({ page, errors }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Menu/ }).click();
    await expect(page.locator('app-menu-panel')).toBeVisible();
    await expect(page.locator('app-menu-panel')).toContainText('Total precipitable water');
    await expect(page.locator('app-menu-panel')).toContainText('AI 1km');
    expect(errors).toEqual([]);
  });
});
