/**
 * The fulfill means **peered and payable**, not merely peered.
 *
 * Establishing a peering opens a payment channel; it does not fund one. Until
 * this file existed, a broadcaster who paid the slot price was peered, routed,
 * on the roster, visible in the quote — and carried nothing, because the hub's
 * own connector will not sign a covering claim against an empty channel and
 * answers `T00` naming its own internal state rather than the deposit nobody
 * made.
 *
 * So every assertion here is over what the **fake operator surface actually
 * holds** after a real app answered a real purchase over HTTP: the channel,
 * what is in it, and what order the hub's own writes arrived in. Nothing
 * reaches inside the funding module, and nothing asserts that a function was
 * called.
 *
 * The five things this pins down:
 *
 *   - the channel behind the peering **holds what the hub's collateral policy
 *     fronts**, and it is funded **before the first route is written** — a
 *     route toward an empty channel is an address that is reachable, paid for
 *     and dead;
 *   - a **retry deposits nothing**, because `POST /channels/:id/fund` takes an
 *     increment and the app reads what the channel holds before it adds
 *     anything. This is the one write in the app where repeating it spends
 *     real money, and the fake is deliberately willing to be called twice so
 *     that an app which forgot would double the hub's exposure here rather
 *     than on a chain;
 *   - a **renewal tops up rather than deposits again**, including the case
 *     that makes the distinction visible: a hub operator who raised the figure
 *     between periods deposits the difference and not the whole of it;
 *   - a funding that fails is a **named, paid refusal about the hub's own
 *     node**, leaves the peering standing, writes no route, records no slot,
 *     and is followed by a retry that costs no second channel and no second
 *     deposit;
 *   - and the slot **records the channel it funded and what is in it**, so the
 *     commitment `TOON_SLOT_CAP` bounds is a number the hub operator's own
 *     roster address reports rather than one they compute from two configured
 *     figures and hope is right. A renewal keeps the same channel and reports
 *     the top-up; a restart, which reconciles, leaves it exactly as it was.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  publicKeyOf,
  startFakeOperatorSurface,
} from '../operator/fake-operator-surface.js';
import type { FakeOperatorSurface } from '../operator/fake-operator-surface.js';
import { startFakeStationConnector } from '../peering/fake-station-connector.js';
import type {
  FakeStationConnector,
  FakeStationRung,
} from '../peering/fake-station-connector.js';
import { startSlotApp } from '../slot-app/slot-app.js';
import type { SlotAppConfig, SlotAppInstance } from '../slot-app/slot-app.js';

/** What a broadcaster reads back, written out rather than imported. */
interface BoughtBody {
  prefix: string;
  label: string;
  peering: {
    localLabel: string;
    channel: { id: string; status: string; chain: string };
  };
  routes: { prefix: string; price: string }[];
}

/** A refusal, as the caller reads it. */
interface RefusalBody {
  error: string;
  message: string;
}

const HUB_ADDRESS = 'g.toon.slopmachine.testhub';

/** Two rungs is enough: this file is about a deposit, not about a ladder. */
const LADDER: readonly FakeStationRung[] = [
  { rung: 'now', price: '50' },
  { rung: 'audio', price: '200' },
];

const PLACEHOLDER_APEX = 'g.toon.slopmachine.demo';

/**
 * What the suite's hub fronts per broadcaster. Deliberately not the shipped
 * placeholder: a figure a test states itself is a figure a changed default
 * cannot quietly satisfy.
 */
const COLLATERAL = 4_000_000;

/** Long enough that nothing lapses underneath an assertion here. */
const PERIOD_SECONDS = 3600;

const running: SlotAppInstance[] = [];
const surfaces: FakeOperatorSurface[] = [];
const stations: FakeStationConnector[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const surface of surfaces.splice(0)) await surface.stop();
  for (const connector of stations.splice(0)) await connector.stop();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Hub {
  app: SlotAppInstance;
  operator: FakeOperatorSurface;
  /** Bring the same hub up again, optionally on a different policy. */
  reboot(config?: Partial<SlotAppConfig>): Promise<SlotAppInstance>;
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slot-collateral-'));
  tempDirs.push(dir);
  return dir;
}

/** Throwaway credentials, mounted at real files. Fresh and random per hub. */
function mountCredentials(dir: string): {
  seed: string;
  writeKeyFile: string;
  bearerToken: string;
  bearerTokenFile: string;
} {
  const seed = randomBytes(32).toString('hex');
  const writeKeyFile = join(dir, 'operator-signing.key');
  writeFileSync(writeKeyFile, `${seed}\n`, { mode: 0o600 });

  const bearerToken = randomBytes(32).toString('hex');
  const bearerTokenFile = join(dir, 'operator-bearer.token');
  writeFileSync(bearerTokenFile, `${bearerToken}\n`, { mode: 0o600 });

  return { seed, writeKeyFile, bearerToken, bearerTokenFile };
}

/** A real hub against a fake operator surface that verifies for real. */
async function boot(config: Partial<SlotAppConfig> = {}): Promise<Hub> {
  const dataDir = freshDir();
  const mounted = mountCredentials(dataDir);

  const operator = await startFakeOperatorSurface({
    writeKeys: [publicKeyOf(mounted.seed)],
    bearerToken: mounted.bearerToken,
  });
  surfaces.push(operator);

  const start = async (
    overrides: Partial<SlotAppConfig>
  ): Promise<SlotAppInstance> => {
    const app = await startSlotApp({
      slotPort: 0,
      host: '127.0.0.1',
      dataDir,
      hubAddress: HUB_ADDRESS,
      slotPeriodSeconds: PERIOD_SECONDS,
      peeringCollateral: COLLATERAL,
      operatorUrl: operator.url,
      // A local topology with no certificate anywhere, exactly as the hub's
      // own local overlay is.
      allowPlaintextStationUrls: true,
      operatorWriteKeyFile: mounted.writeKeyFile,
      operatorBearerTokenFile: mounted.bearerTokenFile,
      ...overrides,
    });
    running.push(app);
    return app;
  };

  const app = await start(config);

  return {
    app,
    operator,
    async reboot(overrides: Partial<SlotAppConfig> = {}) {
      await app.stop();
      const restarted = await start({ ...config, ...overrides });
      // Wait out the second the old process signed in: an accepted signature
      // is spent, Ed25519 is deterministic, and a fresh signer does not
      // remember what its predecessor signed.
      await new Promise((wake) =>
        setTimeout(wake, 1000 - (Date.now() % 1000) + 50)
      );
      return restarted;
    },
  };
}

async function bootStation(): Promise<FakeStationConnector> {
  const connector = await startFakeStationConnector({
    apex: PLACEHOLDER_APEX,
    ladder: LADDER,
  });
  stations.push(connector);
  return connector;
}

function appUrl(app: SlotAppInstance, path: string): string {
  return `http://127.0.0.1:${String(app.config.slotPort)}${path}`;
}

function evmPayer(): string {
  return `evm:0x${randomUUID().replaceAll('-', '').repeat(2)}`;
}

/** Pull a quote and point the station at the prefix it granted. */
async function configured(
  app: SlotAppInstance,
  payer: string,
  connector: FakeStationConnector
): Promise<string> {
  const res = await fetch(appUrl(app, '/quote'), {
    headers: { 'x-toon-payer': payer, 'x-toon-amount': '50' },
  });
  const { prefix } = (await res.json()) as { prefix: string };
  connector.terminateAt(prefix);
  return prefix;
}

function buy(
  app: SlotAppInstance,
  payer: string,
  connector: FakeStationConnector
): Promise<Response> {
  return fetch(appUrl(app, '/buy'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-toon-payer': payer,
      'x-toon-amount': '1000000',
      'x-toon-chain': 'evm',
    },
    body: JSON.stringify({ stationUrl: connector.url }),
  });
}

async function bought(
  app: SlotAppInstance,
  payer: string,
  connector: FakeStationConnector
): Promise<BoughtBody> {
  const res = await buy(app, payer, connector);
  const answered: unknown = await res.json();
  if (res.status !== 200) {
    throw new Error(
      `expected a purchase, got ${String(res.status)}: ${JSON.stringify(answered)}`
    );
  }
  return answered as BoughtBody;
}

/** The roster address's answer, only as far as this file reads it. */
interface RosterBody {
  slots: {
    payer: string;
    label: string;
    lapsesAt: number;
    channelId: string | null;
    collateral: string | null;
  }[];
}

async function roster(app: SlotAppInstance): Promise<RosterBody> {
  const res = await fetch(appUrl(app, '/roster'));
  if (res.status !== 200) {
    throw new Error(`expected a roster, got ${String(res.status)}`);
  }
  return (await res.json()) as RosterBody;
}

/** Whether the hub is holding a slot for this payer, as the quote reports it. */
async function holdsSlot(
  app: SlotAppInstance,
  payer: string
): Promise<boolean> {
  const res = await fetch(appUrl(app, '/quote'), {
    headers: { 'x-toon-payer': payer, 'x-toon-amount': '50' },
  });
  const { slot } = (await res.json()) as { slot: unknown };
  return slot !== null;
}

/** Every funding write the hub made, in the order it made them. */
function fundings(operator: FakeOperatorSurface): { path: string }[] {
  return operator
    .writes()
    .filter((write) => write.path.endsWith('/fund'))
    .map((write) => ({ path: write.path }));
}

// ---------- The channel is funded, and funded before the routes ----------

describe('a purchase funds the channel it opened', () => {
  it('leaves the channel holding what the hub fronts', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    const purchased = await bought(app, payer, station);

    // The connector's own record of the money, not the answer's word for it.
    expect(operator.channels()).toEqual([
      {
        id: purchased.peering.channel.id,
        counterparty: expect.any(String) as string,
        status: 'open',
        // The counterparty's own side is theirs and this hub never moves it.
        deposited: 0,
        own_deposited: COLLATERAL,
        redeemed: 0,
      },
    ]);
  });

  it('funds it before it writes the first route toward it', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    await bought(app, payer, station);

    // The order IS the design: a route written toward an empty channel is an
    // address that is reachable, paid for, and answers T00 to every packet.
    const paths = operator.writes().map((write) => write.path);
    expect(paths[0]).toBe('/peers');
    expect(paths[1]).toMatch(/^\/channels\/[^/]+\/fund$/);
    expect(paths.slice(2)).toEqual(['/routes/peers', '/routes/peers']);
  });

  it('follows the operator’s own figure, whatever it is', async () => {
    // The collateral is the hub's policy and nothing else decides it.
    const { app, operator } = await boot({ peeringCollateral: 12_345 });
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    await bought(app, payer, station);

    expect(operator.channels().map((channel) => channel.own_deposited)).toEqual(
      [12_345]
    );
  });

  it('deposits nothing a purchase asked it to', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    const res = await fetch(appUrl(app, '/buy'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-toon-payer': payer,
        'x-toon-amount': '1000000',
        'x-toon-chain': 'evm',
      },
      body: JSON.stringify({
        stationUrl: station.url,
        // How much capital the hub commits is the hub's own business.
        collateral: 999_999_999,
        amount: 999_999_999,
        own_deposited: 999_999_999,
      }),
    });
    expect(res.status).toBe(200);
    await res.json();

    expect(operator.channels().map((channel) => channel.own_deposited)).toEqual(
      [COLLATERAL]
    );
  });
});

// ---------- The write is an increment, so repeating it must not double ----------

describe('a repeated purchase deposits nothing', () => {
  it('leaves the hub’s exposure exactly where the first one left it', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    const first = await bought(app, payer, station);
    const second = await bought(app, payer, station);

    // Same channel, found rather than created — and one funding write across
    // the two purchases, because the second one read the channel, found it
    // already holding what the hub fronts, and wrote nothing.
    expect(second.peering.channel.id).toBe(first.peering.channel.id);
    expect(second.peering.channel.status).toBe('found');
    expect(fundings(operator)).toHaveLength(1);
    expect(operator.channels().map((channel) => channel.own_deposited)).toEqual(
      [COLLATERAL]
    );
  });

  it('survives a funding write that failed transiently, without depositing twice', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    // A chain that did not answer in time, once. The failure lands AFTER the
    // signature is spent, so the retry has to be freshly signed — and it has
    // to re-read the channel rather than re-send what it sent, which is the
    // difference between a hub that recovers and a hub that deposits twice.
    operator.failNextWrites(1, '/channels/');

    await bought(app, payer, station);

    expect(fundings(operator)).toHaveLength(2);
    expect(operator.channels().map((channel) => channel.own_deposited)).toEqual(
      [COLLATERAL]
    );
    expect(operator.refusals()).toEqual([]);
  });
});

// ---------- A renewal tops up; it does not deposit again ----------

describe('a renewal tops the channel back up', () => {
  it('deposits nothing while the channel still holds what the hub fronts', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    await bought(app, payer, station);
    await bought(app, payer, station);
    await bought(app, payer, station);

    // Three periods, one deposit. A long-lived station stays payable without
    // the hub's capital growing every period.
    expect(fundings(operator)).toHaveLength(1);
    expect(operator.channels().map((channel) => channel.own_deposited)).toEqual(
      [COLLATERAL]
    );
  });

  it('deposits only the difference when the operator has raised the figure', async () => {
    const hub = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(hub.app, payer, station);
    await bought(hub.app, payer, station);

    // The hub operator decides to front more per broadcaster and restarts.
    const raised = await hub.reboot({
      peeringCollateral: COLLATERAL + 500_000,
    });
    await configured(raised, payer, station);
    await bought(raised, payer, station);

    // Topped UP to the new figure, not deposited again on top of the old one.
    expect(fundings(hub.operator)).toHaveLength(2);
    expect(
      hub.operator.channels().map((channel) => channel.own_deposited)
    ).toEqual([COLLATERAL + 500_000]);
  });
});

// ---------- A funding that fails ----------

describe('a channel this hub cannot fund', () => {
  it('names the hub’s own node, writes no route and records no slot', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    // Every attempt the app will make, so the purchase is refused rather than
    // retried into a success.
    operator.failNextWrites(3, '/channels/');

    const res = await buy(app, payer, station);
    const refused = (await res.json()) as RefusalBody;

    expect(res.status).toBe(503);
    expect(refused.error).toBe('channel_not_funded');
    // A broadcaster reading this must not go looking at their own connector
    // for a deposit only the hub can make.
    expect(refused.message).toContain('Nothing about your node');

    // No route toward a channel that cannot carry a packet, and no slot: the
    // hub does not count a caller it could not make payable as admitted.
    expect(operator.routes()).toEqual([]);
    expect(await holdsSlot(app, payer)).toBe(false);
  });

  it('leaves the peering standing, so a retry costs no second channel', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    // Exactly the three attempts one purchase makes, and no more: the retry
    // below has to meet a surface that has recovered.
    operator.failNextWrites(3, '/channels/');
    const refusedRes = await buy(app, payer, station);
    await refusedRes.json();
    expect(refusedRes.status).toBe(503);

    // The peering is there, and its channel is open and empty — which is the
    // honest state, and the one a retry is for. Rolling it back would spend
    // gas to destroy the thing the retry needs.
    expect(operator.peerings()).toHaveLength(1);
    expect(operator.channels().map((channel) => channel.own_deposited)).toEqual(
      [0]
    );

    const retried = await bought(app, payer, station);

    expect(retried.peering.channel.status).toBe('found');
    expect(operator.channels()).toHaveLength(1);
    expect(operator.channels().map((channel) => channel.own_deposited)).toEqual(
      [COLLATERAL]
    );
    expect(await holdsSlot(app, payer)).toBe(true);
  });
});

// ---------- What the hub committed, where an operator can read it ----------

describe('the slot records the channel the hub funded', () => {
  it('reports it at the roster, beside what it holds', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    const purchased = await bought(app, payer, station);
    const listed = (await roster(app)).slots;

    // The commitment TOON_SLOT_CAP bounds, read rather than computed: which
    // channel this hub funded for this broadcaster, and how much is in it.
    expect(listed).toHaveLength(1);
    expect(listed[0]?.channelId).toBe(purchased.peering.channel.id);
    expect(listed[0]?.collateral).toBe(String(COLLATERAL));

    // And it is the hub's own connector's channel, not a number the app made
    // up: the same identifier, holding the same amount.
    expect(
      operator
        .channels()
        .map((channel) => [channel.id, channel.own_deposited] as const)
    ).toEqual([[listed[0]?.channelId, COLLATERAL]]);
  });

  it('reports a decimal string, because a commitment is base units', async () => {
    // The same reason a granted price is a string: an amount is a u128 of
    // base units, and a hub that round-tripped one through a JSON number
    // would report a commitment it does not have.
    const { app } = await boot({ peeringCollateral: 9_007_199_254_740_991 });
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    await bought(app, payer, station);

    expect((await roster(app)).slots[0]?.collateral).toBe('9007199254740991');
  });

  it('keeps the same channel across a renewal, and reports the top-up', async () => {
    const hub = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(hub.app, payer, station);
    const first = await bought(hub.app, payer, station);

    const raised = await hub.reboot({
      peeringCollateral: COLLATERAL + 250_000,
    });
    await configured(raised, payer, station);
    await bought(raised, payer, station);

    // One slot, the same channel, and the figure the renewal topped it up to.
    const listed = (await roster(raised)).slots;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.channelId).toBe(first.peering.channel.id);
    expect(listed[0]?.collateral).toBe(String(COLLATERAL + 250_000));
  });

  it('survives the restart that reconciles, unchanged', async () => {
    const hub = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(hub.app, payer, station);
    const purchased = await bought(hub.app, payer, station);
    const before = (await roster(hub.app)).slots;

    // A boot reconciles the connector's tables against the roster. It writes
    // no roster row, so what the hub funded is what it funded: a boot that
    // rewrote this would be a boot inventing a commitment.
    const restarted = await hub.reboot();

    expect((await roster(restarted)).slots).toEqual(before);
    expect(before[0]?.channelId).toBe(purchased.peering.channel.id);
  });
});
