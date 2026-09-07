/**
 * The discovery grid, driven in a real browser against the running demo.
 *
 * Prerequisite: `pnpm demo --pattern` is up — the devnet topology with the
 * run's own test pattern, no OBS needed. The demo's broadcaster announces the
 * station, publishes a heartbeat while on the air, and every value asserted
 * below is a stable literal of the demo itself: the profile name and the
 * categories from `deploy/devnet/demo.ts`, the two-rung ladder and its
 * per-segment prices from `deploy/devnet/templates/station-connector.toml`.
 * The granted address is derived per run, so the spec asserts everything BUT
 * the address — the card is found by the broadcaster's display name.
 *
 * The guide itself is served by the harness's own web server (see
 * `playwright.config.ts`); this file only needs the relay to be there, and
 * fails fast with the command to run when it is not.
 */

import { test, expect } from 'playwright/test';

/** The devnet relay's free NIP-01 read surface — the guide's own default. */
const RELAY_URL = 'ws://127.0.0.1:7100';

/** From `deploy/devnet/demo.ts`, stable literals of the demo broadcaster. */
const BROADCASTER_NAME = 'The Demo Broadcaster';
const CATEGORIES = ['slop', 'demo'];

/** From the devnet's station connector template: rung → per-segment price. */
const LADDER = [
  { rung: 'audio', price: '200' },
  { rung: '480p', price: '1000' },
];

/** The demo's fixed segment duration, which the announcement carries. */
const SEGMENT_SECONDS = 2;

test.beforeAll(async () => {
  // Fail fast, with the fix in the message, rather than timing out card by
  // card against a relay that was never there.
  await new Promise<void>((ready, refuse) => {
    const socket = new WebSocket(RELAY_URL);
    const patience = setTimeout(() => {
      socket.close();
      refuse(unreachable());
    }, 5_000);
    socket.addEventListener('open', () => {
      clearTimeout(patience);
      socket.close();
      ready();
    });
    socket.addEventListener('error', () => {
      clearTimeout(patience);
      refuse(unreachable());
    });
  });

  function unreachable(): Error {
    return new Error(
      `no relay is answering at ${RELAY_URL} — this harness drives the grid against the running demo. ` +
        'Start it first: `pnpm demo --pattern` (needs the Docker daemon), wait for the station to come on the air, then re-run `pnpm test:guide`.'
    );
  }
});

test('the demo station is on the grid, live, with its real ladder', async ({
  page,
}) => {
  await page.goto('/');

  const card = page
    .getByTestId('station-card')
    .filter({ hasText: BROADCASTER_NAME })
    .first();

  // The card exists: the announcement was read off the relay and rendered,
  // titled by the kind 0 profile's display name.
  await expect(card).toBeVisible({ timeout: 30_000 });

  // The ladder LEADS, at the station's own per-segment prices — the two-rung
  // devnet ladder, verbatim, one row per rung.
  for (const rung of LADDER) {
    await expect(
      card.getByTestId('rung-row').filter({ hasText: rung.rung }).first()
    ).toContainText(`${rung.price} / ${String(SEGMENT_SECONDS)}s segment`);
  }

  // The categories the broadcaster picked, as announced.
  for (const category of CATEGORIES) {
    await expect(
      card.getByTestId('category-badge').filter({ hasText: category }).first()
    ).toBeVisible();
  }

  // The live badge: an unexpired heartbeat exists, because the demo is on
  // the air and republishing one. Patient, because the first beat lands only
  // once the pattern is up.
  await expect(card.getByTestId('live-badge')).toBeVisible({
    timeout: 90_000,
  });
});

test('the sidebar lists the live station', async ({ page }) => {
  await page.goto('/');

  await expect(
    page
      .getByTestId('live-station')
      .filter({ hasText: BROADCASTER_NAME })
      .first()
  ).toBeVisible({ timeout: 90_000 });
});
