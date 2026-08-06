/**
 * Playwright, for the Electron main-process tests only.
 *
 * Deliberately narrow. Jest owns the 640-odd unit and component suites and is
 * fast enough to run on every save; this exists for the handful of claims that
 * are only true in a real main process — the IPC frame guard above all, which
 * was asserted against a stubbed frame identity and said so in its own file.
 *
 * No browser projects and no dev server: nothing here drives the renderer
 * through a URL, so a `webServer` block would only add a port to fight over.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // Electron apps take a real launch; the default 30s is tight on a cold start
  // under a virus scanner, which is the environment this actually runs in.
  timeout: 60_000,
  // One Electron instance at a time. They contend for the same user-data
  // directory, and a flaky suite in CI is a suite people learn to re-run.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
