import { defineConfig, devices } from '@playwright/test';

/**
 * E2E suite runs against the locally running stack (dev servers or the
 * docker-compose stack). WEB_URL / API_URL env vars override for CI or
 * container networking.
 */
const WEB_URL = process.env.WEB_URL ?? 'http://localhost:3000';
export const API_URL = process.env.API_URL ?? 'http://localhost:3001';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
