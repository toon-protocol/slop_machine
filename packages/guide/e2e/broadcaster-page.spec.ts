/**
 * The broadcaster page, driven in a real browser against the running demo.
 *
 * Prerequisite: `pnpm demo --pattern` is up, exactly as `discovery.spec.ts`
 * says. The demo's broadcaster announces a profile, a station and one clip —
 * and since #78 the clip points at media the run itself serves, so playing
 * it here is a real free fetch of real sound, not a URL nothing answers.
 *
 * Every value asserted is a stable literal of the demo: the profile name and
 * about from `deploy/devnet/demo.ts`, the ladder from the devnet's station
 * connector template, the clip's title and duration from
 * `deploy/devnet/clip-media.ts`. The granted address is derived per run, so
 * the page is reached the way a viber reaches it — by clicking the station's
 * card on the grid — and the handle is asserted only by shape.
 */

import { test, expect } from 'playwright/test';

/** The devnet relay's free NIP-01 read surface — the guide's own default. */
const RELAY_URL = 'ws://127.0.0.1:7100';

/** From `deploy/devnet/demo.ts`, stable literals of the demo broadcaster. */
const BROADCASTER_NAME = 'The Demo Broadcaster';
const BROADCASTER_ABOUT =
  'your own OBS, playing back one paid packet at a time';
const CATEGORIES = ['slop', 'demo'];

/** From the devnet's station connector template: rung → per-segment price. */
const LADDER = [
  { rung: 'audio', price: '200' },
  { rung: '480p', price: '1000' },
];

/** The demo's fixed segment duration, which the announcement carries. */
const SEGMENT_SECONDS = 2;

/** From `deploy/devnet/clip-media.ts`: the demo's one clip, as announced. */
const CLIP_TITLE = 'first light';
const CLIP_DURATION = '0:06';

test.beforeAll(async () => {
  // Fail fast, with the fix in the message, rather than timing out against a
  // relay that was never there.
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
      `no relay is answering at ${RELAY_URL} — this harness drives the broadcaster page against the running demo. ` +
        'Start it first: `pnpm demo --pattern` (needs the Docker daemon), wait for the station to come on the air, then re-run `pnpm test:guide`.'
    );
  }
});

test('a card leads to the broadcaster page: profile, ladder, and the empty viber-count slot', async ({
  page,
}) => {
  await page.goto('/');

  // The way a viber gets there: the grid's card is the link.
  const card = page
    .getByTestId('station-card')
    .filter({ hasText: BROADCASTER_NAME })
    .first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();

  // The handle is the hub's to derive — lower-case hex — so it is asserted
  // by shape where every other value is a literal.
  await expect(page).toHaveURL(/\/b\/[0-9a-f]{12,64}$/);

  // The kind 0 profile: display name and about, rendered.
  await expect(page.getByTestId('broadcaster-name')).toHaveText(
    BROADCASTER_NAME
  );
  await expect(page.getByTestId('broadcaster-about')).toHaveText(
    BROADCASTER_ABOUT
  );

  // The full rung ladder at the station's own per-segment prices.
  for (const rung of LADDER) {
    await expect(
      page.getByTestId('rung-row').filter({ hasText: rung.rung }).first()
    ).toContainText(`${rung.price} / ${String(SEGMENT_SECONDS)}s segment`);
  }

  // The categories the broadcaster picked, as announced.
  for (const category of CATEGORIES) {
    await expect(
      page.getByTestId('category-badge').filter({ hasText: category }).first()
    ).toBeVisible();
  }

  // The live badge, on the heartbeat's terms — the demo is on the air.
  await expect(page.getByTestId('live-badge')).toBeVisible({
    timeout: 90_000,
  });

  // The viber-count slot: present in the layout, absent in value.
  const slot = page.locator('[data-slot="viber-count"]');
  await expect(slot).toBeVisible();
  await expect(page.getByTestId('viber-count-value')).toHaveText('');
});

test('a clip is listed with its title and duration, and plays from a free fetch', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByTestId('station-card')
    .filter({ hasText: BROADCASTER_NAME })
    .first()
    .click({ timeout: 30_000 });

  // The clip list: the demo's one clip, titled and timed as announced.
  const clip = page
    .getByTestId('clip-row')
    .filter({ hasText: CLIP_TITLE })
    .first();
  await expect(clip).toBeVisible({ timeout: 30_000 });
  await expect(clip.getByTestId('clip-duration')).toHaveText(CLIP_DURATION);

  // Play it. The media element's own clock is the proof: a currentTime that
  // advances past zero means bytes arrived from the free fetch and playback
  // really started.
  await clip.click();
  const player = page.getByTestId('clip-player');
  await expect(player).toBeVisible();
  await expect
    .poll(
      () =>
        player.evaluate((element) => (element as HTMLVideoElement).currentTime),
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0);
});

test('an unannounced handle still renders an honest page', async ({ page }) => {
  await page.goto('/b/nobody-announced-this');

  // The handle is shown, the absence is said plainly, and the viber-count
  // slot is still reserved — no station, no pretence of one.
  await expect(
    page.getByRole('heading', { name: 'nobody-announced-this' })
  ).toBeVisible();
  await expect(
    page.getByText('Nothing is announced for this broadcaster')
  ).toBeVisible();
  await expect(page.locator('[data-slot="viber-count"]')).toBeVisible();
});
