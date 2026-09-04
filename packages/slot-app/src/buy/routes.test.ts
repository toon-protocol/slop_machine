/**
 * The routes a purchase writes — being peered made into being *reachable*.
 *
 * Every assertion here is over one of exactly two things: **what a real app
 * answered over HTTP**, or **what the fake operator surface ended up
 * holding**. Nothing asserts that a function was called, and nothing reaches
 * into the derivation, the signer or the HTTP client.
 *
 * **The prices come from a document, not from a stub.** A fake station
 * connector is booted in-process and serves a real self-description
 * (connector ADR 0050) with a real ladder at real prices, spelled the way
 * that document spells prices — decimal strings of the settlement asset's
 * base units. The hub goes and reads it over HTTP, exactly as it would read a
 * broadcaster's own node, so the numbers in the hub's routing table below are
 * numbers this app *derived* rather than numbers a test handed it.
 *
 * The arithmetic the whole issue turns on, written out once:
 *
 * ```
 *   hub route price  =  station's published price  +  hub's carriage fee
 * ```
 *
 * A hub route priced below that forwards into the station's own per-packet
 * price check (connector ADR 0029) and is refused there — reachable, paid
 * for, and dead. Which is why every price below is asserted as a literal sum
 * of two literals.
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
  FakeStationConnectorOptions,
  FakeStationRung,
} from '../peering/fake-station-connector.js';
import { startSlotApp } from '../slot-app/slot-app.js';
import type { SlotAppConfig, SlotAppInstance } from '../slot-app/slot-app.js';

/**
 * What a broadcaster reads once they are reachable, written out here rather
 * than imported: a change to what they depend on fails this file instead of
 * quietly agreeing with itself.
 */
interface BoughtBody {
  prefix: string;
  label: string;
  lapsesAt: number;
  routes: { prefix: string; price: string; pricePerKib?: string }[];
  peering: { localLabel: string; channel: { id: string } };
}

interface RefusalBody {
  error: string;
  message: string;
}

interface QuoteBody {
  prefix: string;
  slot: { lapsesAt: number } | null;
}

const HUB_ADDRESS = 'g.toon.slopmachine.testhub';

/**
 * The ladder the station sells: four rungs and its own *now*, at the prices
 * the committed station bundle prices them at. These five numbers are the
 * left-hand side of every sum in this file.
 */
const LADDER: readonly FakeStationRung[] = [
  { rung: 'now', price: '50' },
  { rung: 'audio', price: '200' },
  { rung: '480p', price: '1000' },
  { rung: '720p', price: '2000' },
  { rung: '1080p', price: '3500' },
];

/** What the hub retains for carrying one packet. The right-hand side. */
const CARRIAGE = 10;

/**
 * The apex the committed station bundle ships. `demo` is a placeholder for
 * the handle a hub grants, and a station left this way has not been
 * configured for the hub it is buying from.
 */
const PLACEHOLDER_APEX = 'g.toon.slopmachine.demo';

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
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slot-routes-'));
  tempDirs.push(dir);
  return dir;
}

/** A throwaway operator key pair, mounted at real files as a hub mounts them. */
function mountCredentials(dir: string): {
  seed: string;
  writeKeyFile: string;
  bearerToken: string;
  bearerTokenFile: string;
} {
  const seed = randomBytes(32).toString('hex');
  const writeKeyFile = join(dir, 'operator-write.key');
  writeFileSync(writeKeyFile, `${seed}\n`, { mode: 0o600 });

  const bearerToken = randomBytes(32).toString('hex');
  const bearerTokenFile = join(dir, 'operator-bearer.token');
  writeFileSync(bearerTokenFile, `${bearerToken}\n`, { mode: 0o600 });

  return { seed, writeKeyFile, bearerToken, bearerTokenFile };
}

/** Boot a real hub against a fake operator surface that verifies for real. */
async function boot(
  config: Partial<SlotAppConfig> = {},
  options: { configOwns?: (prefix: string) => boolean } = {}
): Promise<Hub> {
  const dataDir = freshDir();
  const mounted = mountCredentials(dataDir);

  const operator = await startFakeOperatorSurface({
    writeKeys: [publicKeyOf(mounted.seed)],
    bearerToken: mounted.bearerToken,
    ...(options.configOwns === undefined
      ? {}
      : { configOwns: options.configOwns }),
  });
  surfaces.push(operator);

  const app = await startSlotApp({
    slotPort: 0,
    host: '127.0.0.1',
    dataDir,
    hubAddress: HUB_ADDRESS,
    peeringFee: CARRIAGE,
    operatorUrl: operator.url,
    operatorWriteKeyFile: mounted.writeKeyFile,
    operatorBearerTokenFile: mounted.bearerTokenFile,
    ...config,
  });
  running.push(app);

  return { app, operator };
}

/** A station connector serving a real self-description on its own port. */
async function bootStation(
  options: Partial<FakeStationConnectorOptions> = {}
): Promise<FakeStationConnector> {
  const connector = await startFakeStationConnector({
    apex: PLACEHOLDER_APEX,
    ladder: LADDER,
    ...options,
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

async function quote(app: SlotAppInstance, payer: string): Promise<QuoteBody> {
  const res = await fetch(appUrl(app, '/quote'), {
    headers: { 'x-toon-payer': payer, 'x-toon-amount': '50' },
  });
  return (await res.json()) as QuoteBody;
}

function buy(
  app: SlotAppInstance,
  payer: string,
  stationUrl: string
): Promise<Response> {
  return fetch(appUrl(app, '/buy'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-toon-payer': payer,
      'x-toon-amount': '1000000',
      'x-toon-chain': 'evm',
    },
    body: JSON.stringify({ stationUrl }),
  });
}

/**
 * What a broadcaster actually does: pull a quote, write the prefix it granted
 * into their own station's configuration, boot, and then buy.
 */
async function configured(
  app: SlotAppInstance,
  payer: string,
  connector: FakeStationConnector
): Promise<string> {
  const { prefix } = await quote(app, payer);
  connector.terminateAt(prefix);
  return prefix;
}

async function bought(
  app: SlotAppInstance,
  payer: string,
  connector: FakeStationConnector
): Promise<BoughtBody> {
  const res = await buy(app, payer, connector.url);
  const answered: unknown = await res.json();
  if (res.status !== 200) {
    throw new Error(
      `expected a purchase, got ${String(res.status)}: ${JSON.stringify(answered)}`
    );
  }
  return answered as BoughtBody;
}

// ---------- Every rung the station sells ----------

describe('the routes a purchase writes', () => {
  it('carries every rung and the station’s now, priced from the station itself', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    const prefix = await configured(app, payer, station);

    const purchased = await bought(app, payer, station);

    // What the hub's routing table ends up holding — not which function ran.
    // One row per prefix the station publishes, each toward the peering the
    // purchase established, each at the station's own price plus carriage.
    expect(operator.routes()).toEqual([
      { prefix: `${prefix}.now`, peer_id: purchased.label, price: 50 + 10 },
      { prefix: `${prefix}.audio`, peer_id: purchased.label, price: 200 + 10 },
      { prefix: `${prefix}.480p`, peer_id: purchased.label, price: 1000 + 10 },
      { prefix: `${prefix}.720p`, peer_id: purchased.label, price: 2000 + 10 },
      {
        prefix: `${prefix}.1080p`,
        peer_id: purchased.label,
        price: 3500 + 10,
      },
    ]);
    // The hub read the station's own document rather than being told a price.
    expect(station.reads()).toBe(1);
  });

  it("routes the station's now at its own cheap price, not a segment's", async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    const prefix = await configured(app, payer, station);

    await bought(app, payer, station);

    // A viber joining at the live edge must not pay a segment price to find
    // it: the station prices its *now* apart, and the hop keeps it apart.
    const now = operator.routes().find((r) => r.prefix === `${prefix}.now`);
    const cheapestRung = operator
      .routes()
      .find((r) => r.prefix === `${prefix}.audio`);
    expect(now?.price).toBe(50 + 10);
    expect(cheapestRung?.price).toBe(200 + 10);
  });

  it('answers the granted prefix, the routes written and when the slot lapses', async () => {
    const { app } = await boot({ slotPeriodSeconds: 900 });
    const station = await bootStation();
    const payer = evmPayer();
    const prefix = await configured(app, payer, station);

    const before = Date.now();
    const purchased = await bought(app, payer, station);

    expect(purchased.prefix).toBe(prefix);
    expect(purchased.lapsesAt).toBeGreaterThanOrEqual(before + 900_000);
    // Prices as decimal strings, the same spelling the station's own document
    // uses: a price is a u64 of base units and is not a JSON number.
    expect(purchased.routes).toEqual([
      { prefix: `${prefix}.now`, price: '60' },
      { prefix: `${prefix}.audio`, price: '210' },
      { prefix: `${prefix}.480p`, price: '1010' },
      { prefix: `${prefix}.720p`, price: '2010' },
      { prefix: `${prefix}.1080p`, price: '3510' },
    ]);
  });

  it("follows the hub operator's own carriage fee, whatever it is", async () => {
    const { app, operator } = await boot({ peeringFee: 250 });
    const station = await bootStation();
    const payer = evmPayer();
    const prefix = await configured(app, payer, station);

    await bought(app, payer, station);

    // A broadcaster does not choose how far the hub trusts them, and the
    // carriage is the hub's own number — but the station's price is still the
    // floor the sum is built on.
    expect(
      operator.routes().map((route) => [route.prefix, route.price])
    ).toEqual([
      [`${prefix}.now`, 50 + 250],
      [`${prefix}.audio`, 200 + 250],
      [`${prefix}.480p`, 1000 + 250],
      [`${prefix}.720p`, 2000 + 250],
      [`${prefix}.1080p`, 3500 + 250],
    ]);
  });

  it('adds the carriage to the base and leaves a published slope alone', async () => {
    const { app, operator } = await boot();
    const station = await bootStation({
      ladder: [
        { rung: 'now', price: '50' },
        { rung: 'bulk', price: '1000', pricePerKib: '30' },
      ],
    });
    const payer = evmPayer();
    const prefix = await configured(app, payer, station);

    const purchased = await bought(app, payer, station);

    // A price is a schedule over payload length; a fee deliberately is not.
    // So carriage lands on the base and the slope crosses the hop unchanged —
    // which is what makes the covering exact at every packet size.
    expect(operator.routes()).toEqual([
      { prefix: `${prefix}.now`, peer_id: purchased.label, price: 50 + 10 },
      {
        prefix: `${prefix}.bulk`,
        peer_id: purchased.label,
        price: { base: 1000 + 10, per_kib: 30 },
      },
    ]);
    expect(purchased.routes).toEqual([
      { prefix: `${prefix}.now`, price: '60' },
      { prefix: `${prefix}.bulk`, price: '1010', pricePerKib: '30' },
    ]);
  });

  it('rewrites the same rows when the purchase is repeated', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    await bought(app, payer, station);
    await bought(app, payer, station);

    // Keyed by prefix, so a retried purchase writes the same table rather
    // than a bigger one — and re-reads the station, so a ladder that changed
    // is picked up rather than remembered.
    expect(operator.routes()).toHaveLength(5);
    expect(station.reads()).toBe(2);
  });

  it('leaves alone whatever the station publishes outside its own prefix', async () => {
    const { app, operator } = await boot();
    // The same node also publishes two addresses this hub granted nobody:
    // another broadcaster's, and the hub's own apex. Pointing either at this
    // node would be handing out somebody else's address, so the hub carries
    // the five it granted and nothing more.
    const station = await bootStation({
      alsoPublishes: [
        { prefix: 'g.toon.slopmachine.testhub.somebodyelse.now', price: '50' },
        { prefix: HUB_ADDRESS, price: '1' },
      ],
    });
    const payer = evmPayer();
    const prefix = await configured(app, payer, station);

    await bought(app, payer, station);

    expect(operator.routes().map((route) => route.prefix)).toEqual([
      `${prefix}.now`,
      `${prefix}.audio`,
      `${prefix}.480p`,
      `${prefix}.720p`,
      `${prefix}.1080p`,
    ]);
  });

  it("is attributable to the slot app's own key, every write of it", async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    await bought(app, payer, station);

    // The peering and all five routes: six writes, one key, and the fake
    // verified every signature against its allowlist before recording any of
    // them. An audit log can tell what the app did from what an operator did
    // by hand.
    const keys = new Set(operator.writes().map((write) => write.keyid));
    expect(operator.writes()).toHaveLength(6);
    expect(keys.size).toBe(1);
    expect(operator.refusals()).toEqual([]);
  });
});

// ---------- The station the hub cannot make sense of ----------

describe("a station the hub cannot read is told it is the caller's node", () => {
  it('says so when nothing answers at the URL at all', async () => {
    const { app, operator } = await boot();
    const gone = await bootStation();
    const url = gone.url;
    await gone.stop();
    stations.splice(stations.indexOf(gone), 1);

    const res = await buy(app, evmPayer(), url);
    const body = (await res.json()) as RefusalBody;

    expect(res.status).toBe(502);
    expect(body.error).toBe('station_unreadable');
    expect(body.message).toMatch(/YOUR node/);
    // Refused before the operator surface was touched at all: a station the
    // hub cannot read costs the hub no channel.
    expect(operator.writes()).toEqual([]);
    expect(operator.peerings()).toEqual([]);
  });

  it('says so when the URL answers something that is not a self-description', async () => {
    const { app, operator } = await boot();

    for (const station of [
      await bootStation({ body: '<html>an origin, not a connector</html>' }),
      await bootStation({ status: 404 }),
      await bootStation({ redirectTo: 'https://elsewhere.example/ilp' }),
    ]) {
      const res = await buy(app, evmPayer(), station.url);
      const body = (await res.json()) as RefusalBody;

      expect(res.status).toBe(502);
      expect(body.error).toBe('station_unreadable');
      expect(body.message).toMatch(/self-description/);
    }
    expect(operator.writes()).toEqual([]);
  });

  it('says so when a published price is not one this hub can read', async () => {
    const { app, operator } = await boot();
    const station = await bootStation({
      // A price is a decimal string of base units. Anything else is a
      // document this hub refuses to guess at, because guessing means
      // writing a route priced under the station's own termination.
      ladder: [{ rung: 'now', price: '0.05' }],
    });
    const payer = evmPayer();
    await configured(app, payer, station);

    const res = await buy(app, payer, station.url);
    const body = (await res.json()) as RefusalBody;

    expect(res.status).toBe(502);
    expect(body.error).toBe('station_unreadable');
    expect(body.message).toMatch(/0\.05/);
    expect(operator.writes()).toEqual([]);
  });

  it('says so when the station publishes nothing beneath the granted prefix', async () => {
    const { app, operator } = await boot();
    // Never configured: the ladder is still beneath the bundle's `demo`
    // placeholder, so every packet the hub forwarded would arrive somewhere
    // this broadcaster does not terminate.
    const station = await bootStation();
    const payer = evmPayer();
    const { prefix } = await quote(app, payer);

    const res = await buy(app, payer, station.url);
    const body = (await res.json()) as RefusalBody;

    expect(res.status).toBe(502);
    expect(body.error).toBe('station_not_at_prefix');
    expect(body.message).toContain(prefix);
    expect(body.message).toMatch(/YOUR node/);
    // No peering either: a station with nothing to route is refused before
    // the operator surface is touched, so the hub fronts no collateral for a
    // purchase that bought nothing.
    expect(operator.writes()).toEqual([]);
    expect(operator.peerings()).toEqual([]);
  });
});

// ---------- The row the hub operator reserved ----------

describe('a route the hub’s own config file owns', () => {
  it('is refused, and no slot is left behind', async () => {
    // The hub operator has reserved an address that falls inside this
    // caller's grant. A runtime row may never shadow a config one.
    const { app, operator } = await boot(
      {},
      { configOwns: (prefix) => prefix.endsWith('.480p') }
    );
    const station = await bootStation();
    const payer = evmPayer();
    const prefix = await configured(app, payer, station);

    const res = await buy(app, payer, station.url);
    const body = (await res.json()) as RefusalBody;

    expect(res.status).toBe(409);
    expect(body.error).toBe('route_owned_by_config');
    expect(body.message).toContain(`${prefix}.480p`);

    // No half-written slot: the hub does not count this caller as admitted,
    // the quote still says they hold nothing, and a restart would not find
    // one either.
    expect((await quote(app, payer)).slot).toBeNull();
    // The routes written before the collision are keyed by prefix and are
    // rewritten rather than duplicated by a retry; the reserved one was never
    // taken, which is the whole point.
    expect(operator.routes().map((route) => route.prefix)).toEqual([
      `${prefix}.now`,
      `${prefix}.audio`,
    ]);
  });
});

// ---------- The hub's own surface ----------

describe('an operator surface that will not take a route', () => {
  it('names the hub, and records no slot', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);
    // The peering lands; every attempt at the first route does not.
    operator.failNextWrites(3, '/routes/peers');

    const res = await buy(app, payer, station.url);
    const body = (await res.json()) as RefusalBody;

    expect(res.status).toBe(503);
    expect(body.error).toBe('routes_not_written');
    expect(body.message).toMatch(/hub operator/);
    expect(operator.routes()).toEqual([]);
    expect((await quote(app, payer)).slot).toBeNull();
  });
});
