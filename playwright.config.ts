import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: the production build (`npm run build` first) served by scripts/preview.js, driven in Chromium. The radar pictures are
 * saved ones (src/app/core/services/testdata), so the tests do not depend on IMD; see e2e/fixtures.ts.
 *   npx playwright test            (all)
 *   npx playwright test --headed   (watch it)
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:8080',
    // the service worker would fetch on the page's behalf, past the routes that serve the saved radar pictures
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node scripts/preview.js',
    url: 'http://localhost:8080',
    reuseExistingServer: !process.env['CI'],
    timeout: 30_000,
  },
});
