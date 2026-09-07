/**
 * Browsing by the vibes, driven in a real browser against the running demo.
 *
 * Prerequisite: `pnpm demo --pattern` is up — the devnet topology with the
 * run's own test pattern, no OBS needed. The demo's broadcaster announces
 * the station under two free-form categories, and every value asserted below
 * is a stable literal of the demo itself: the categories and the profile
 * name from `deploy/devnet/demo.ts`, the two-rung ladder and its per-segment
 * prices from the devnet's station connector template.
 *
 * What this file proves, against real announcements: a tile exists per
 * announced category and curation adds none — a curated name nobody
 * announced gets no tile — and a tile leads to a category page rendering
 * the SAME station cards the discovery grid uses, ladder and live badge
 * intact, with a multi-category station appearing under each of its
 * categories.
 */

import { test, expect } from 'playwright/test';

/** The devnet relay's free NIP-01 read surface — the guide's own default. */
const RELAY_URL = 'ws://127.0.0.1:7100';

/** From `deploy/devnet/demo.ts`, stable literals of the demo broadcaster. */
const BROADCASTER_NAME = 'The Demo Broadcaster';
const CATEGORIES = ['slop', 'demo'];

/**
 * The guide's own curation, from `src/routes/categories.tsx`: `slop` is on
 * the featured list and announced, so its tile leads and is marked; `demo`
 * is announced and uncurated, so it gets an ordinary tile all the same; and
 * `music` is on the featured list with nobody announcing it, so it gets no
 * tile at all — prominence, never existence.
 */
const FEATURED_ANNOUNCED = 'slop';
const UNCURATED_ANNOUNCED = 'demo';
const FEATURED_UNANNOUNCED = 'music';

/** From the devnet's station connector template: rung → per-segment price. */
const LADDER = [
  { rung: 'audio', price: '200' },
  { rung: '480p', price: '1000' },
];

/** The demo's fixed segment duration, which the announcement carries. */
const SEGMENT_SECONDS = 2;

test.beforeAll(async () => {
  // Fail fast, with the fix in the message, rather than timing out tile by
  // tile against a relay that was never there.
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
      `no relay is answering at ${RELAY_URL} — this harness drives the guide against the running demo. ` +
        'Start it first: `pnpm demo --pattern` (needs the Docker daemon), wait for the station to come on the air, then re-run `pnpm test:guide`.'
    );
  }
});

test('a tile per announced category, and none for the curated name nobody announced', async ({
  page,
}) => {
  await page.goto('/categories');

  // Every category the demo broadcaster announced gets a tile — curated or
  // not.
  for (const category of CATEGORIES) {
    await expect(
      page.getByTestId('category-tile').filter({ hasText: category }).first()
    ).toBeVisible({ timeout: 30_000 });
  }

  // Curation is prominence: the featured, announced category is marked.
  await expect(
    page
      .getByTestId('category-tile')
      .filter({ hasText: FEATURED_ANNOUNCED })
      .first()
      .getByTestId('featured-badge')
  ).toBeVisible();

  // The uncurated announced category has a tile and no mark.
  await expect(
    page
      .getByTestId('category-tile')
      .filter({ hasText: UNCURATED_ANNOUNCED })
      .first()
      .getByTestId('featured-badge')
  ).toHaveCount(0);

  // Curation is never existence: the featured name nobody announced gets no
  // tile. Asserted only after the announced tiles are visible, so this is a
  // claim about the rendered page rather than about one still loading.
  await expect(
    page.getByTestId('category-tile').filter({ hasText: FEATURED_UNANNOUNCED })
  ).toHaveCount(0);
});

test('tile to category page to a station card, under each announced category', async ({
  page,
}) => {
  await page.goto('/categories');

  // Through the featured tile to its category page.
  const tile = page
    .getByTestId('category-tile')
    .filter({ hasText: FEATURED_ANNOUNCED })
    .first();
  await expect(tile).toBeVisible({ timeout: 30_000 });
  await tile.click();
  await expect(page).toHaveURL(
    new RegExp(`/categories/${FEATURED_ANNOUNCED}$`)
  );

  // The SAME card discovery uses: titled by the profile's display name, the
  // two-rung ladder verbatim at the station's own per-segment prices.
  const card = page
    .getByTestId('station-card')
    .filter({ hasText: BROADCASTER_NAME })
    .first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  for (const rung of LADDER) {
    await expect(
      card.getByTestId('rung-row').filter({ hasText: rung.rung }).first()
    ).toContainText(`${rung.price} / ${String(SEGMENT_SECONDS)}s segment`);
  }

  // The live badge rides along: the demo is on the air and republishing a
  // heartbeat. Patient, because the first beat lands only once the pattern
  // is up.
  await expect(card.getByTestId('live-badge')).toBeVisible({
    timeout: 90_000,
  });

  // A station announcing several categories appears under each: the same
  // station, on its other category's page.
  await page.goto(`/categories/${UNCURATED_ANNOUNCED}`);
  const cardAgain = page
    .getByTestId('station-card')
    .filter({ hasText: BROADCASTER_NAME })
    .first();
  await expect(cardAgain).toBeVisible({ timeout: 30_000 });

  // And the card is the grid's card all the way through: it leads to the
  // broadcaster page.
  await cardAgain.click();
  await expect(page).toHaveURL(/\/b\/.+/);
});

test('a category nobody announced renders the honest empty state', async ({
  page,
}) => {
  await page.goto(`/categories/${FEATURED_UNANNOUNCED}`);

  await expect(
    page.getByRole('heading', { name: FEATURED_UNANNOUNCED })
  ).toBeVisible();
  await expect(
    page.getByText('No station is announced under this category yet.')
  ).toBeVisible();
});
