import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

import { E2E_BASE_URL } from './e2e/constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Playwright's default output paths are `test-results/` and `playwright-report/` directly under
// packages/web — both plain generated JSON/HTML, but the repo-root `format:check` gate
// (prettier, out of this wave's file lane to reconfigure) walks the whole tree by default and
// isn't told about them. Routing both under `build/` instead reuses the root .prettierignore's
// existing bare `build` entry (gitignore-style patterns without a leading slash match at any
// depth), so this stays a packages/web-only change. See packages/web/.gitignore.
const outputRoot = path.join(here, 'build');

export default defineConfig({
  testDir: path.join(here, 'e2e'),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // One real server + one SQLite file, shared by the whole run (see global-setup.ts) — tests
  // must not race each other, so no parallelism within this suite.
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  outputDir: path.join(outputRoot, 'test-results'),
  reporter: process.env['CI']
    ? [
        ['list'],
        ['html', { open: 'never', outputFolder: path.join(outputRoot, 'playwright-report') }],
      ]
    : [['list']],
  globalSetup: path.join(here, 'e2e/global-setup.ts'),
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
