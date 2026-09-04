/**
 * The buy, as a broadcaster meets it — and as a hub operator's routing table
 * ends up holding it.
 *
 * Every assertion here is over one of exactly two things: **what a real app
 * answered over HTTP at its own boundary**, or **what the fake operator
 * surface actually recorded**. Nothing reaches into the roster's on-disk
 * layout, the handle derivation, the signer, or the HTTP client — all four
 * stay rewritable without touching this file. The roster's durability is
 * asserted the way a broadcaster would find out about it: by stopping the app
 * and asking a fresh one.
 *
 * The fake operator surface is a **fake, not a mock**: it verifies the RFC
 * 9421 signature and the `Content-Digest` for real against an allowlisted
 * public key, refuses an unsigned write, refuses a replayed signature, and
 * records what was written. So "the write was signed correctly" is not
 * something this file asserts about a function call — it is the reason the
 * peering exists at all.
 *
 * The response shape is written out below rather than imported, so that a
 * change to what a broadcaster depends on fails this file instead of quietly
 * agreeing with itself.
 *
 * The **fake station connector** is the same idea on the read side: a real
 * self-description, served in-process, that the hub goes and reads. Its
 * ladder is pointed at the prefix the quote granted exactly as a broadcaster
 * points their own `connector.toml` at it, which is why every successful
 * purchase below pulls a quote first.
 *
 * What this covers (issue #35): the peering established before the answer,
 * the terms it carries, the refusals that cannot be quoted away, the
 * signature and its freshness on a retry, a repeat purchase finding the same
 * channel, and the slot surviving a restart. The routes a purchase writes are
 * `routes.test.ts` (#36); what a renewal means is #37; the lapse is #38.
 */

import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
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
import type { FakeStationConnector } from '../peering/fake-station-connector.js';
import { startSlotApp } from '../slot-app/slot-app.js';
import type { SlotAppConfig, SlotAppInstance } from '../slot-app/slot-app.js';

/**
 * What a broadcaster reads once they are peered, written out here rather than
 * imported. This is the contract they configure their station against.
 */
interface BoughtBody {
  prefix: string;
  label: string;
  hubAddress: string;
  lapsesAt: number;
  slotPeriodSeconds: number;
  peering: {
    localLabel: string;
    channel: { id: string; status: string; chain: string };
  };
  routes: { prefix: string; price: string }[];
}

/** A refusal, likewise. */
interface RefusalBody {
  error: string;
  message: string;
}

/** The quote, only as far as this file reads it. */
interface QuoteBody {
  prefix: string;
  label: string;
  slotsHeld: number;
  slot: { lapsesAt: number } | null;
}

/** The suite's hub. A real operator sets their own; that is the point of it. */
const HUB_ADDRESS = 'g.toon.slopmachine.testhub';

/**
 * The ladder the suite's station sells: four rungs and its own *now*, priced
 * as the committed station bundle prices them. Written out here rather than
 * imported, because these are the numbers the hub's own routes are derived
 * from.
 */
const LADDER = [
  { rung: 'now', price: '50' },
  { rung: 'audio', price: '200' },
  { rung: '480p', price: '1000' },
  { rung: '720p', price: '2000' },
  { rung: '1080p', price: '3500' },
] as const;

/**
 * The apex the committed station bundle ships, where `demo` is a placeholder
 * for the handle a hub grants. A station left this way has not been
 * configured for the hub it is buying from.
 */
const PLACEHOLDER_APEX = 'g.toon.slopmachine.demo';

/**
 * One station connector for the file, re-pointed per purchase — which is what
 * a broadcaster does to their own `connector.toml` once a quote has told them
 * their prefix.
 */
let station: FakeStationConnector;

beforeAll(async () => {
  station = await startFakeStationConnector({
    apex: PLACEHOLDER_APEX,
    ladder: LADDER,
  });
});

afterAll(async () => {
  await station.stop();
});

const running: SlotAppInstance[] = [];
const surfaces: FakeOperatorSurface[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
  for (const surface of surfaces.splice(0)) await surface.stop();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One hub: a data directory, a mounted key pair, and its operator surface. */
interface Hub {
  app: SlotAppInstance;
  operator: FakeOperatorSurface;
  dataDir: string;
}

/**
 * A throwaway operator write key, mounted at a real file the way a hub's
 * compose file mounts the real thing: a 32-byte ed25519 seed as 64 hex
 * characters, which is what `openssl rand -hex 32` writes. Fresh per boot and
 * random — no credential literal belongs in this repository, not even a
 * test's.
 */
function mountCredentials(dir: string): {
  seed: string;
  writeKeyFile: string;
  bearerTokenFile: string;
} {
  const seed = randomBytes(32).toString('hex');
  const writeKeyFile = join(dir, 'operator-write.key');
  writeFileSync(writeKeyFile, `${seed}\n`, { mode: 0o600 });

  const bearerTokenFile = join(dir, 'operator-bearer.token');
  writeFileSync(bearerTokenFile, `${randomBytes(32).toString('hex')}\n`, {
    mode: 0o600,
  });

  return { seed, writeKeyFile, bearerTokenFile };
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slot-buy-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Boot a real hub: a fake operator surface with the app's own public key on
 * its allowlist, and a real slot app pointed at it through configuration.
 */
async function boot(
  config: Partial<SlotAppConfig> = {},
  options: {
    dataDir?: string;
    stationIsReadable?: (url: string) => boolean;
  } = {}
): Promise<Hub> {
  const dataDir = options.dataDir ?? freshDir();
  const mounted = mountCredentials(dataDir);

  // The allowlist holds the PUBLIC half, derived by the fake's own code from
  // the seed the operator generated — exactly what a hub operator pastes into
  // their connector's `write_keys`.
  const operator = await startFakeOperatorSurface({
    writeKeys: [publicKeyOf(mounted.seed)],
    ...(options.stationIsReadable === undefined
      ? {}
      : { stationIsReadable: options.stationIsReadable }),
  });
  surfaces.push(operator);

  const app = await startSlotApp({
    slotPort: 0,
    host: '127.0.0.1',
    dataDir,
    hubAddress: HUB_ADDRESS,
    operatorUrl: operator.url,
    operatorWriteKeyFile: mounted.writeKeyFile,
    operatorBearerTokenFile: mounted.bearerTokenFile,
    ...config,
  });
  running.push(app);

  return { app, operator, dataDir };
}

/** A payer key shaped exactly as a terminating connector states one. */
function evmPayer(): string {
  return `evm:0x${randomUUID().replaceAll('-', '').repeat(2)}`;
}

function appUrl(app: SlotAppInstance, path: string): string {
  return `http://127.0.0.1:${String(app.config.slotPort)}${path}`;
}

/** How the connector in front states a delivery it verified. */
interface Delivery {
  payer?: string | undefined;
  amount?: string | undefined;
  chain?: string | undefined;
}

/**
 * Buy a slot the way the connector in front of the app would deliver the
 * purchase: the three attribution headers it states, and a body carrying only
 * the station connector's URL.
 */
function buy(
  app: SlotAppInstance,
  delivery: Delivery,
  body: unknown = { stationUrl: station.url },
  path = '/buy'
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (delivery.payer !== undefined) headers['x-toon-payer'] = delivery.payer;
  if (delivery.amount !== undefined) headers['x-toon-amount'] = delivery.amount;
  if (delivery.chain !== undefined) headers['x-toon-chain'] = delivery.chain;

  return fetch(appUrl(app, path), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/** A delivery that pays what the hub asks, on the chain the payer paid on. */
function paid(payer: string, amount = '1000000'): Delivery {
  return { payer, amount, chain: payer.split(':')[0] ?? 'evm' };
}

/**
 * What a broadcaster does before they pay: pull the quote, take the prefix the
 * hub granted, and point their own station's ladder at it.
 *
 * The dance is real rather than convenient — a hub only routes what a station
 * publishes beneath the prefix it granted, so a purchase made before this is
 * a purchase by somebody who has not configured their station.
 */
async function configureStation(
  app: SlotAppInstance,
  payer: string
): Promise<string> {
  const quoted = await quote(app, payer);
  station.terminateAt(quoted.prefix);
  return quoted.prefix;
}

/** The slot a broadcaster bought, or a failure saying what came back instead. */
async function bought(
  app: SlotAppInstance,
  delivery: Delivery,
  body?: unknown
): Promise<BoughtBody> {
  if (delivery.payer !== undefined) {
    await configureStation(app, delivery.payer);
  }
  const res = await buy(app, delivery, body);
  const answered: unknown = await res.json();
  if (res.status !== 200) {
    throw new Error(
      `expected a purchase, got ${String(res.status)}: ${JSON.stringify(answered)}`
    );
  }
  return answered as BoughtBody;
}

/** What the quote says about a payer right now. */
async function quote(app: SlotAppInstance, payer: string): Promise<QuoteBody> {
  const res = await fetch(appUrl(app, '/quote'), {
    headers: { 'x-toon-payer': payer, 'x-toon-amount': '50' },
  });
  return (await res.json()) as QuoteBody;
}

/** What the hub actually wrote to its own connector, as the fake recorded it. */
function writtenPeering(
  operator: FakeOperatorSurface,
  index = 0
): Record<string, unknown> {
  const write = operator.writes()[index];
  if (write === undefined) {
    throw new Error(
      `expected at least ${String(index + 1)} operator write(s), found ${String(operator.writes().length)}`
    );
  }
  return JSON.parse(write.body) as Record<string, unknown>;
}

// ---------- The purchase ----------

describe('buying a slot', () => {
  it('establishes the peering and answers the prefix and the lapse', async () => {
    const { app, operator } = await boot({ slotPeriodSeconds: 900 });
    const payer = evmPayer();
    await configureStation(app, payer);

    const before = Date.now();
    const res = await buy(app, paid(payer));
    const body = (await res.json()) as BoughtBody;
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('cache-control')).toBe('no-store');

    expect(body.hubAddress).toBe(HUB_ADDRESS);
    expect(body.prefix).toBe(`${HUB_ADDRESS}.${body.label}`);
    expect(body.slotPeriodSeconds).toBe(900);
    expect(body.lapsesAt).toBeGreaterThanOrEqual(before + 900_000);
    expect(body.lapsesAt).toBeLessThanOrEqual(after + 900_000);

    // The fulfill means you are peered: by the time this answer existed, the
    // hub's routing table already held the peering. No polling, no status
    // surface — the outcome IS the response.
    expect(operator.peerings()).toHaveLength(1);
    expect(operator.peerings()[0]?.id).toBe(body.label);
    expect(operator.peerings()[0]?.url).toBe(station.url);
    expect(body.peering.localLabel).toBe(body.label);
    expect(body.peering.channel.status).toBe('created');
    expect(body.peering.channel.id).toBe(operator.peerings()[0]?.channel.id);
  });

  it('peers at the prefix the quote already promised', async () => {
    const { app } = await boot();
    const payer = evmPayer();

    const quoted = await quote(app, payer);
    const purchased = await bought(app, paid(payer));

    // A broadcaster writes the quoted prefix into their own connector.toml
    // and boots against it BEFORE they pay. If the buy granted a different
    // one, every packet the hub forwarded would arrive somewhere the station
    // does not terminate.
    expect(purchased.prefix).toBe(quoted.prefix);
    expect(purchased.label).toBe(quoted.label);
  });

  it("carries the hub's own terms and the chain the connector stated", async () => {
    const { app, operator } = await boot({
      peeringFee: 42,
      peeringMaxPacketAmount: 777_000,
    });
    const payer = `solana:${randomUUID().replaceAll('-', '')}`;

    const purchased = await bought(app, {
      payer,
      amount: '1000000',
      chain: 'solana',
    });

    const written = writtenPeering(operator);
    // The local label is the derived handle; the carriage terms are the hub's
    // own; the chain is the one the broadcaster demonstrably paid on, so the
    // peering never settles on a guess between two shared chains.
    expect(written).toEqual({
      id: purchased.label,
      url: station.url,
      fee: 42,
      max_packet_amount: 777_000,
      chain: 'solana',
    });
    expect(purchased.peering.channel.chain).toBe('solana');
  });

  it('lets a broadcaster choose nothing but their own URL', async () => {
    const { app, operator } = await boot({
      peeringFee: 7,
      peeringMaxPacketAmount: 500,
    });

    await bought(app, paid(evmPayer()), {
      stationUrl: station.url,
      // Everything a broadcaster might wish for and does not get to have.
      id: 'vanity',
      label: 'vanity',
      fee: 0,
      max_packet_amount: 999_999_999,
      chain: 'evm',
      lapsesAt: Number.MAX_SAFE_INTEGER,
    });

    const written = writtenPeering(operator);
    expect(written['fee']).toBe(7);
    expect(written['max_packet_amount']).toBe(500);
    expect(written['id']).not.toBe('vanity');
  });
});

// ---------- What the operator surface never sees ----------

describe('a purchase that is refused before any operator write', () => {
  it('is refused with no payer, without the operator surface being touched', async () => {
    const { app, operator } = await boot();

    const res = await buy(app, { amount: '1000000', chain: 'evm' });
    const body = (await res.json()) as RefusalBody;

    expect(res.status).toBe(403);
    expect(body.error).toBe('no_paid_termination');
    expect(body.message).toMatch(/paid termination/i);
    expect(body.message).toMatch(/X-TOON-Payer/);

    // Not "no peering was written" — the surface was never spoken to at all,
    // which is what stops a misconfigured hub handing out free peerings.
    expect(operator.writes()).toEqual([]);
    expect(operator.refusals()).toEqual([]);
    expect(operator.peerings()).toEqual([]);
  });

  it('is refused when the route in front charged less than a slot costs', async () => {
    const { app, operator } = await boot({ slotPrice: 1_000_000 });

    const res = await buy(app, {
      payer: evmPayer(),
      amount: '999999',
      chain: 'evm',
    });
    const body = (await res.json()) as RefusalBody;

    expect(res.status).toBe(403);
    expect(body.error).toBe('route_under_charges');
    // Reading a fact the connector stated is not validating a payment. This
    // exists so a route misconfigured to under-charge cannot sell slots.
    expect(body.message).toMatch(/1000000/);
    expect(body.message).toMatch(/999999/);
    expect(operator.writes()).toEqual([]);
    expect(operator.peerings()).toEqual([]);
  });

  it('is refused when the connector stated no amount at all', async () => {
    const { app, operator } = await boot();

    const res = await buy(app, { payer: evmPayer(), chain: 'evm' });
    const body = (await res.json()) as RefusalBody;

    expect(res.status).toBe(403);
    expect(body.error).toBe('route_under_charges');
    expect(operator.writes()).toEqual([]);
  });

  it('sells the slot when the stated amount is exactly the price', async () => {
    const { app } = await boot({ slotPrice: 1_000_000 });

    const purchased = await bought(app, {
      payer: evmPayer(),
      amount: '1000000',
      chain: 'evm',
    });

    expect(purchased.prefix.startsWith(`${HUB_ADDRESS}.`)).toBe(true);
  });

  it('is refused when the body names no station connector', async () => {
    const { app, operator } = await boot();

    for (const body of [{}, { stationUrl: '' }, { stationUrl: 'not a url' }]) {
      const res = await buy(app, paid(evmPayer()), body);
      const refusal = (await res.json()) as RefusalBody;

      expect(res.status).toBe(400);
      expect(refusal.error).toBe('no_station_url');
      expect(refusal.message).toMatch(/stationUrl/);
    }
    expect(operator.writes()).toEqual([]);
  });
});

// ---------- The signature the operator surface actually checked ----------

describe('the write the hub signs', () => {
  it('is signed with the mounted key and bound to the body', async () => {
    const { app, operator } = await boot();

    await bought(app, paid(evmPayer()));

    const write = operator.writes()[0];
    // The write was ACCEPTED, which is the assertion: the fake rebuilt the
    // signature base from the request it received, checked the digest against
    // the body it received, and verified ed25519 against its allowlist. A
    // signature over the wrong base, or one not bound to this body, never
    // gets recorded here at all.
    expect(write).toBeDefined();
    expect(write?.headers['signature-input']).toMatch(
      /\("@method" "@path" "content-digest"\);created=\d+;expires=\d+;keyid="[0-9a-f]{64}";alg="ed25519"/
    );
    expect(write?.headers['signature']).toMatch(/^sig1=:[A-Za-z0-9+/=]+:$/);
    expect(write?.headers['content-digest']).toMatch(
      /^sha-256=:[A-Za-z0-9+/=]+:$/
    );
  });

  it('is refused by the operator surface when it is not signed at all', async () => {
    const { operator } = await boot();

    const res = await fetch(`${operator.url}/peers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'unsigned', url: station.url }),
    });
    await res.arrayBuffer();

    expect(res.status).toBe(401);
    expect(operator.refusals().map((r) => r.reason)).toContain('unsigned');
    expect(operator.peerings()).toEqual([]);
  });

  it('is refused by the operator surface when it is replayed', async () => {
    const { app, operator } = await boot();

    await bought(app, paid(evmPayer()));
    const write = operator.writes()[0];
    expect(write).toBeDefined();

    // Sent again, byte for byte, exactly as the hub sent it the first time —
    // no re-signing anywhere in this test. An accepted signature is spent.
    const replayed = await fetch(`${operator.url}${write?.path ?? ''}`, {
      method: 'POST',
      headers: write?.headers ?? {},
      body: write?.body ?? '',
    });
    await replayed.arrayBuffer();

    expect(replayed.status).toBe(401);
    expect(operator.refusals().map((r) => r.reason)).toContain('replayed');
  });

  it('is signed afresh on a retry rather than replayed', async () => {
    const { app, operator } = await boot();
    // One authenticated write fails after its signature has been spent —
    // a chain that did not confirm in time. The retry has to be a write the
    // surface will accept, and a replay of the first one would not be.
    operator.failNextWrites(1);

    const purchased = await bought(app, paid(evmPayer()));

    // The peering write, twice — the routes that follow it are their own
    // writes and are #36's business, not this test's.
    const attempts = operator.writes().filter((w) => w.path === '/peers');
    expect(attempts).toHaveLength(2);
    const [first, second] = attempts;
    expect(second?.body).toBe(first?.body);
    // Same write, same key, different signature: `created` advanced rather
    // than the bytes being repeated.
    expect(second?.headers['signature']).not.toBe(first?.headers['signature']);
    expect(second?.created).toBeGreaterThan(first?.created ?? 0);
    expect(second?.keyid).toBe(first?.keyid);
    // And nothing was ever refused as a replay: the retry rescued the
    // purchase instead of being turned into a second failure.
    expect(operator.refusals()).toEqual([]);
    expect(purchased.peering.channel.status).toBe('created');
  });
});

// ---------- Retrying the purchase itself ----------

describe('a purchase made twice', () => {
  it('finds the same channel rather than opening a second one', async () => {
    const { app, operator } = await boot();
    const payer = evmPayer();

    const first = await bought(app, paid(payer));
    const second = await bought(app, paid(payer));

    // A broadcaster whose answer arrived too late retries. Gas was already
    // spent; the retry must find the work done rather than pay for the same
    // peering twice.
    expect(second.label).toBe(first.label);
    expect(second.peering.channel.id).toBe(first.peering.channel.id);
    expect(first.peering.channel.status).toBe('created');
    expect(second.peering.channel.status).toBe('found');
    expect(operator.peerings()).toHaveLength(1);
  });
});

// ---------- The refusals that cannot be quoted away ----------

describe('a station the hub cannot read', () => {
  it("is told about, and told it is about the broadcaster's own node", async () => {
    const { app, operator } = await boot(
      {},
      { stationIsReadable: () => false }
    );

    const payer = evmPayer();
    await configureStation(app, payer);

    const res = await buy(app, paid(payer));
    const body = (await res.json()) as RefusalBody;

    expect(res.status).toBe(502);
    expect(body.error).toBe('station_unreadable');
    // It names the caller's connector as the thing to fix, so they fix it
    // rather than retrying into the same charge. This is the one refusal ADR
    // 0003's amendment says cannot be moved to the quote.
    expect(body.message).toMatch(/YOUR node/);
    expect(body.message).toMatch(/self-description/);
    expect(operator.peerings()).toEqual([]);
  });

  it('is not retried into the broadcaster deadline', async () => {
    const { app, operator } = await boot(
      {},
      { stationIsReadable: () => false }
    );

    const payer = evmPayer();
    await configureStation(app, payer);
    await (await buy(app, paid(payer))).arrayBuffer();

    // Asking again cannot change the answer, and the packet's deadline is the
    // broadcaster's to spend.
    expect(operator.writes()).toHaveLength(1);
  });
});

describe('an operator surface that will not take the write', () => {
  it('names the hub, not the broadcaster', async () => {
    const { app, operator } = await boot();
    const payer = evmPayer();
    await configureStation(app, payer);
    // Every attempt fails: not a slow chain, a hub that cannot write.
    operator.failNextWrites(10);

    const res = await buy(app, paid(payer));
    const body = (await res.json()) as RefusalBody;

    expect(res.status).toBe(503);
    expect(body.error).toBe('peering_not_established');
    expect(body.message).toMatch(/hub operator/);
    // Retried inside the request before it gave up — a slow chain must not
    // cost a broadcaster a purchase on the first stumble.
    expect(operator.writes().length).toBeGreaterThan(1);
    expect(operator.peerings()).toEqual([]);
  });
});

// ---------- Durability, and the answer that came too late ----------

describe('the slot on disk', () => {
  it('is written before the response is sent', async () => {
    const dataDir = freshDir();
    const first = await boot({ slotPeriodSeconds: 3600 }, { dataDir });
    const payer = evmPayer();

    const purchased = await bought(first.app, paid(payer));
    // Stopped the instant the answer arrived — nothing runs between the
    // response and this line, so anything found afterwards was already on
    // disk when the broadcaster was told they were peered.
    await first.app.stop();

    const second = await boot({ slotPeriodSeconds: 3600 }, { dataDir });
    const quoted = await quote(second.app, payer);

    expect(quoted.slot).not.toBeNull();
    expect(quoted.slot?.lapsesAt).toBe(purchased.lapsesAt);
  });

  it('is read back at boot, so a restarted hub reports the same slot', async () => {
    const dataDir = freshDir();
    const first = await boot({ slotPeriodSeconds: 3600 }, { dataDir });
    const payer = evmPayer();
    const other = evmPayer();

    const purchased = await bought(first.app, paid(payer));
    await first.app.stop();

    const second = await boot({ slotPeriodSeconds: 3600 }, { dataDir });
    const mine = await quote(second.app, payer);
    const theirs = await quote(second.app, other);

    // A reboot must not lose track of who is admitted: the hub is already
    // funding a channel toward them.
    expect(mine.slot?.lapsesAt).toBe(purchased.lapsesAt);
    expect(mine.prefix).toBe(purchased.prefix);
    expect(mine.slotsHeld).toBe(1);
    // And somebody who never bought still holds nothing.
    expect(theirs.slot).toBeNull();
    expect(theirs.slotsHeld).toBe(1);
  });

  it('is reported at the quote the moment the purchase answers', async () => {
    const { app } = await boot({ slotPeriodSeconds: 3600 });
    const payer = evmPayer();

    expect((await quote(app, payer)).slot).toBeNull();
    const purchased = await bought(app, paid(payer));
    const quoted = await quote(app, payer);

    expect(quoted.slot?.lapsesAt).toBe(purchased.lapsesAt);
  });
});

// ---------- Where the buy lives ----------

describe('where the buy lives', () => {
  it('is a POST at its own prefix and nowhere else', async () => {
    const { app } = await boot();
    const payer = evmPayer();
    await configureStation(app, payer);

    expect((await buy(app, paid(payer))).status).toBe(200);

    // Nothing sits beneath /buy, and nothing else sells a slot. An address
    // reachable at another address's price is a slot sold for the cost of a
    // quote — or a quote sold for the cost of a slot.
    for (const path of ['/', '/buys', '/buy/slot', '/slots', '/peers']) {
      const res = await buy(app, paid(payer), undefined, path);
      await res.arrayBuffer();
      expect(res.status).toBe(404);
    }
  });

  it('does not answer a GET, and the quote does not answer a POST', async () => {
    const { app } = await boot();

    const got = await fetch(appUrl(app, '/buy'), {
      headers: { 'x-toon-payer': evmPayer() },
    });
    await got.arrayBuffer();
    expect(got.status).toBe(404);

    const posted = await fetch(appUrl(app, '/quote'), {
      method: 'POST',
      headers: { 'x-toon-payer': evmPayer() },
    });
    await posted.arrayBuffer();
    expect(posted.status).toBe(404);
  });
});

// ---------- Still no payment code ----------

describe('the buy holds no payment code', () => {
  it('reads the three headers the connector stated and echoes none back', async () => {
    const { app } = await boot();
    const payer = evmPayer();
    await configureStation(app, payer);

    const res = await buy(app, paid(payer));
    const body = await res.text();

    expect(res.status).toBe(200);
    for (const header of [
      'x-payment',
      'x-payment-response',
      'x-toon-payer',
      'x-toon-amount',
      'x-toon-chain',
      'www-authenticate',
    ]) {
      expect(res.headers.get(header)).toBeNull();
    }
    // The verified payer key is the hub's join key into its own records, not
    // the broadcaster's to see quoted back at them.
    expect(body).not.toContain(payer);
  });

  it('never writes the payer key into the hub routing table', async () => {
    const { app, operator } = await boot();
    const payer = evmPayer();

    await bought(app, paid(payer));

    // The handle is derived from the payer; the payer itself is the hub's
    // own business and does not become a label on somebody else's connector.
    expect(operator.writes()[0]?.body).not.toContain(payer);
  });
});
