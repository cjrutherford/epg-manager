import { defineConfig } from '@playwright/test';
import path from 'path';

/**
 * The suite starts its own servers against a seeded database.
 *
 * It used to point at `localhost:3302` — the docker-compose port — and assume
 * something was already running there with data in it. That is why it failed on
 * a clean checkout: the tests were not testing the application so much as
 * asking whether the machine happened to have one running.
 */

const FIXTURE_DIR = path.resolve(process.cwd(), '.e2e-fixture');

/**
 * Ports well away from the defaults, so a dev server can stay up alongside —
 * and away from anything else on the machine. The first choice, 4310, turned
 * out to belong to an unrelated nginx, and the suite spent a run testing it.
 */
const API_PORT = 45210;
const WEB_PORT = 45211;

// Playwright cannot install Firefox/WebKit on every host (Ubuntu 26.04 is not
// supported at the time of writing). Keep the projects available without
// making an ordinary test run fail on an unsupported machine.
const crossBrowserProjects = process.env.CROSS_BROWSER === '1'
    ? [
        { name: 'firefox', testMatch: /cross-browser\.spec\.ts/, use: { browserName: 'firefox' as const } },
        { name: 'webkit', testMatch: /cross-browser\.spec\.ts/, use: { browserName: 'webkit' as const } },
    ]
    : [];

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/fixture/global-setup.ts',
  timeout: 30000,
  expect: { timeout: 5000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : [['html', { open: 'never' }]],

  // The documentation walkthrough is its own project: it records video always
  // and is excluded from ordinary runs, which should be fast and silent.
  projects: [
    {
      name: 'e2e',
      use: { channel: 'chrome' },
      testIgnore: [
        /docs\//,
        /visual\//,
        /cross-browser\.spec\.ts/,
        // The TV/remote gate is its own project: it drives focus from the
        // keyboard at 1080p and is not part of the pointer-oriented e2e run.
        /tv\.spec\.ts/,
        // Anything that mutates state other specs assert on runs in the
        // destructive project, serially, after these.
        /reset-scopes\.spec\.ts/,
        /series-rules\.spec\.ts/,
        /dvr-lifecycle\.spec\.ts/,
        /job-queue\.spec\.ts/,
      ],
    },
    {
      name: 'e2e-destructive',
      testMatch: /(series-rules|dvr-lifecycle|job-queue)\.spec\.ts/,
      use: { channel: 'chrome' },
      dependencies: ['e2e'],
      fullyParallel: false,
    },
    {
      // Reset genuinely destroys the fixture, so it cannot share a database
      // with tests asserting on seeded counts. Running it after everything
      // else, on its own, is the difference between a suite that passes and
      // one that passes only when the scheduler happens to order it last.
      name: 'e2e-reset',
      testMatch: /reset-scopes\.spec\.ts/,
      use: { channel: 'chrome' },
      dependencies: ['e2e-destructive'],
      fullyParallel: false,
    },
    {
      // Screenshot baselines are opt-in: antialiasing differs between machines,
      // so they run as their own project after the functional suite.
      name: 'visual',
      testMatch: /visual\/.*\.spec\.ts/,
      use: { channel: 'chrome' },
      fullyParallel: false,
    },
    {
      // Remote/TV gate. Deliberately independent of the visual and cross-browser
      // projects: it is a Chrome-only, keyboard-only journey through the guide
      // at 1080p, and running its focus assertions beside other specs makes the
      // results depend on stream and scheduler timing.
      name: 'tv',
      testMatch: /tv\.spec\.ts/,
      use: {
        channel: 'chrome',
        viewport: { width: 1920, height: 1080 },
      },
      fullyParallel: false,
    },
    ...crossBrowserProjects,
    {
      name: 'docs',
      testMatch: /docs\/.*\.spec\.ts/,
      use: { channel: 'chrome' },
    },
  ],

  outputDir: './test-results',

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
    headless: true,
    // Video is kept for failures so a red run can be watched rather than
    // reconstructed. The documentation walkthrough opts into recording always.
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  webServer: [
    {
      command: `npx ts-node e2e/fixture/seed-cli.ts "${FIXTURE_DIR}" && npx ts-node src/server.ts`,
      port: API_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        DB_DIR: FIXTURE_DIR,
        API_PORT: String(API_PORT),
        // Matches FIXTURE.adminPassword; the specs sign in with it.
        ADMIN_PASSWORD: 'e2e-fixture-password',
        // Nothing should reach the network during a test run.
        MAX_ACTIVE_STREAMS: '2',
      },
    },
    {
      command: `node client/dist/client/server/server.mjs`,
      port: WEB_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      // The SSR server proxies /api to API_PORT; without this it defaults to
      // 4000 and every request in the suite gets a 503 from the proxy rather
      // than an answer from the application.
      env: { PORT: String(WEB_PORT), API_PORT: String(API_PORT) },
    },
  ],
});

export { API_PORT, WEB_PORT, FIXTURE_DIR };
