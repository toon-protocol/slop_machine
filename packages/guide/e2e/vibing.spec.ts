/**
 * Vibing live, driven end to end in a real browser against the running demo.
 *
 * Prerequisite: `pnpm demo --pattern` is up, exactly as the other specs say —
 * and this one needs the demo's paying side too: the playback contract on
 * loopback (ADR 0005), which the demo's player serves and whose allowlist the
 * demo wires with this harness's own origin. The spec is the whole of #79's
 * loop: click a live station, start vibing through the contract, see the
 * picture arrive, switch rungs mid-broadcast, read the spend and the
 * broadcaster/hub split as the state reports them, stop, and see the spend
 * flatten.
 *
 * Every stable number of the demo is a literal here: the per-segment prices
 * across the hop (the station's own termination plus the hub's carriage of
 * 20), the split each rung shows, and the paying side's budget. The totals
 * grow with real purchases underneath, so they are asserted by movement and
 * by structure, never by value.
 */

import { test, expect } from 'playwright/test';

/** The devnet relay's free NIP-01 read surface — the guide's own default. */
const RELAY_URL = 'ws://127.0.0.1:7100';

/** The demo player's page port, where the playback contract answers. */
const PLAYBACK_URL = 'http://127.0.0.1:8088';

/** From `deploy/devnet/demo.ts`, the demo broadcaster's display name. */
const BROADCASTER_NAME = 'The Demo Broadcaster';

/**
 * What one segment costs the viber across the hop, and how it splits — the
 * station's own termination prices (200, 1000) plus the hub's flat carriage
 * of 20, all stable literals of the devnet.
 */
const RUNGS = [
  { rung: 'audio', price: '220', toStation: '200', toHub: '20' },
  { rung: '480p', price: '1020', toStation: '1000', toHub: '20' },
];

/** The paying side's own budget, from `deploy/devnet/demo.ts` — rendered, never set. */
const BUDGET_PER_SECOND = '1000';

test.beforeAll(async () => {
  // Fail fast, with the fix in the message, rather than timing out against a
  // demo that was never there.
  await new Promise<void>((ready, refuse) => {
    const socket = new WebSocket(RELAY_URL);
    const patience = setTimeout(() => {
      socket.close();
      refuse(unreachable('no relay is answering at ' + RELAY_URL));
    }, 5_000);
    socket.addEventListener('open', () => {
      clearTimeout(patience);
      socket.close();
      ready();
    });
    socket.addEventListener('error', () => {
      clearTimeout(patience);
      refuse(unreachable('no relay is answering at ' + RELAY_URL));
    });
  });

  // The paying side must answer the contract, and the station must be on the
  // air — the pattern takes a moment to fill its first segments.
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const answer = await fetch(`${PLAYBACK_URL}/contract/v1/state`);
      if (answer.ok) {
        const state = (await answer.json()) as {
          contract?: string;
          live?: boolean;
        };
        if (state.contract === 'v1' && state.live === true) break;
      }
    } catch {
      // Not up yet; patience below.
    }
    if (Date.now() > deadline) {
      throw unreachable(
        `the playback contract at ${PLAYBACK_URL} never reported the station on the air`
      );
    }
    await new Promise((waited) => setTimeout(waited, 2_000));
  }

  // The demo's paying side starts vibing of its own accord; this spec is
  // about the CLICK starting it, so stop first — across the contract, as the
  // paying side's own tooling (no Origin header, fenced by loopback).
  const stop = await fetch(`${PLAYBACK_URL}/contract/v1/stop`, {
    method: 'POST',
  });
  if (!stop.ok) {
    throw unreachable('the playback contract refused a stop from the harness');
  }

  function unreachable(what: string): Error {
    return new Error(
      `${what} — this harness drives vibing live against the running demo. ` +
        'Start it first: `pnpm demo --pattern` (needs the Docker daemon), wait for the station to come on the air, then re-run `pnpm test:guide`.'
    );
  }
});

test('click a live station, vibe through the contract, switch rungs, read the spend, stop and see it flatten', async ({
  page,
}) => {
  // The whole loop is one deliberately serial story.
  test.setTimeout(240_000);

  await page.goto('/');

  // The way a viber gets there: the grid's card is the link, live badge and all.
  const card = page
    .getByTestId('station-card')
    .filter({ hasText: BROADCASTER_NAME })
    .first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('live-badge')).toBeVisible({
    timeout: 90_000,
  });
  await card.click();

  // The contract is detected, the demo's station is the payable one, and the
  // harness stopped vibing in beforeAll — so the affordance is the button.
  const vibeButton = page.getByTestId('vibe-live-button');
  await expect(vibeButton).toBeVisible({ timeout: 30_000 });

  // Every rung leads with its price and its split, the state's own decimal
  // strings — stable literals of the demo, rendered and computed nowhere.
  for (const rung of RUNGS) {
    const button = page
      .getByTestId('vibe-rung')
      .filter({ hasText: rung.rung })
      .first();
    await expect(button).toContainText(`${rung.price} / segment`);
    await expect(button).toContainText(
      `${rung.toStation} broadcaster · ${rung.toHub} hub`
    );
  }

  // The paying side's budget, readable and only readable.
  await expect(page.getByTestId('vibe-budget')).toHaveText(BUDGET_PER_SECOND);

  const spent = () =>
    page
      .getByTestId('vibe-spent')
      .evaluate((element) => Number(element.textContent ?? '0'));
  const beforeVibing = await spent();

  // THE CLICK: vibing starts in-page, initiated over the contract.
  await vibeButton.click();

  // The picture arrives — the media element's own clock is the proof that
  // segments the paying side bought are really playing.
  const player = page.getByTestId('live-player');
  await expect(player).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      () =>
        player.evaluate((element) => (element as HTMLVideoElement).currentTime),
      { timeout: 60_000 }
    )
    .toBeGreaterThan(0);

  // The theater opened on the dearest rung, selected through the contract.
  await expect(
    page.locator('[data-testid="vibe-rung"][aria-pressed="true"]')
  ).toContainText('480p');

  // The spend grows — read from the state, never computed here.
  await expect.poll(spent, { timeout: 60_000 }).toBeGreaterThan(beforeVibing);

  // And the split renders from the state's own ledger: real totals underneath,
  // so movement and structure are the assertions, not values.
  const toStation = await page
    .getByTestId('vibe-to-station')
    .evaluate((element) => Number(element.textContent ?? '0'));
  const toHub = await page
    .getByTestId('vibe-to-hub')
    .evaluate((element) => Number(element.textContent ?? '0'));
  expect(
    toStation,
    'the broadcaster half of the split renders'
  ).toBeGreaterThan(0);
  expect(toHub, 'the hub half of the split renders').toBeGreaterThan(0);

  // SWITCH RUNGS MID-BROADCAST: a POST at the paying side, and the playlist
  // follows. The choice is within the budget the paying side owns — nothing
  // here ever sent one.
  await page
    .getByTestId('vibe-rung')
    .filter({ hasText: 'audio' })
    .first()
    .click();
  await expect(
    page.locator('[data-testid="vibe-rung"][aria-pressed="true"]')
  ).toContainText('audio');

  // Still progressing on the new rung: the clock keeps moving over a second.
  await expect
    .poll(
      async () => {
        const first = await player.evaluate(
          (element) => (element as HTMLVideoElement).currentTime
        );
        await page.waitForTimeout(1_000);
        const second = await player.evaluate(
          (element) => (element as HTMLVideoElement).currentTime
        );
        return second - first;
      },
      { timeout: 60_000 }
    )
    .toBeGreaterThan(0);

  // STOP VIBING STOPS THE SPEND: the button POSTs across the contract, the
  // state answers vibing false, and the total goes flat once the last
  // purchases already in flight have landed.
  await page.getByTestId('stop-vibing-button').click();
  await expect(vibeButton).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('not vibing')).toBeVisible();

  await page.waitForTimeout(4_000);
  const flat = await spent();
  await page.waitForTimeout(4_000);
  expect(await spent(), 'the spend kept growing after the stop').toBe(flat);

  // Leave the demo the way it runs: vibing, as its own paying side started.
  await vibeButton.click();
  await expect(page.getByTestId('live-player')).toBeVisible({
    timeout: 15_000,
  });
});
