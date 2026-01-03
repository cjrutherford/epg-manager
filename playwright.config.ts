import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: {
    timeout: 5000
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'html',
  use: {
    baseURL: 'http://localhost:3101',
    trace: 'on-first-retry',
    headless: true,
  },
  webServer: {
    command: 'DB_DIR=./test-data PORT=3101 node dist/server.js',
    url: 'http://localhost:3101/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
