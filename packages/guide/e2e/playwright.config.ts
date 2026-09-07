/**
 * The guide's opt-in Playwright harness — `pnpm test:guide`, never part of
 * `pnpm test`, which must run with no browser, no Docker daemon and no
 * network.
 *
 * The guide's only true test boundary is a browser: the ordinary suite holds
 * the payment-free guard and nothing else, because discovery logic is proven
 * against a REAL relay, not a mock-relay seam. That relay is the running
 * demo's: `pnpm demo --pattern` must already be up — the harness documents
 * the prerequisite rather than booting a four-container topology itself, and
 * the first spec fails fast with the command to run when the relay is not
 * there.
 *
 * The guide itself is served by this config's own web server, `vite dev` on
 * a port of the harness's choosing — no build step, and `reuseExistingServer`
 * means a dev server someone already has open is used rather than fought.
 *
 * Everything a run writes goes to `output/` beside this file — gitignored,
 * and NEVER `deploy/devnet/run/`, which the toolchain excludes because
 * bought segments share TypeScript's extension. The reporter is `list` so no
 * HTML report directory appears anywhere else.
 */

import { defineConfig } from 'playwright/test';

const GUIDE_URL = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: '.',
  outputDir: './output',
  reporter: 'list',
  timeout: 120_000,
  use: {
    baseURL: GUIDE_URL,
    launchOptions: {
      // The broadcaster-page spec plays a clip with sound; a headless run has
      // no gesture history for Chromium's autoplay policy to credit, and a
      // spec must not depend on one.
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: {
    command:
      'pnpm --filter @toon-protocol/guide exec vite --host 127.0.0.1 --port 4173 --strictPort',
    url: GUIDE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
