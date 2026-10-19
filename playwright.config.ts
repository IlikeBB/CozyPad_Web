import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60000,
  workers: 1,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:5684', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/test-server.mjs', url: 'http://127.0.0.1:5684/api/health', timeout: 20000, reuseExistingServer: false }
});
