import { defineConfig } from '@playwright/test'

/**
 * End-to-end: the built binary, a real browser, one whole job.
 *
 * The unit suites know the command is right and the HTTP tests know the server
 * runs it; neither can tell whether a person can actually get from a file to a
 * result. This is the one path that proves the pieces are joined up.
 *
 * The system Chrome is used rather than a downloaded one, so the suite needs no
 * extra 150 MB to run.
 */
export default defineConfig({
  testDir: './e2e',
  // The screenshots for the README are generated on demand by `make
  // screenshots`, not on every run: they take pictures rather than assertions.
  testIgnore: process.env.FFWEB_SCREENSHOTS ? [] : ['**/screenshots.spec.ts'],
  // The hook renders four pieces of footage before the first picture is taken,
  // which on a slow machine outlasts the ordinary limit. It has to be set here
  // rather than in the hook: `test.setTimeout` does not raise a hook's own.
  timeout: process.env.FFWEB_SCREENSHOTS ? 300_000 : 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1600, height: 950 },
  },
})
