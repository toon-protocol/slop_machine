/**
 * Buying again is renewing — one call a broadcaster already knows how to
 * make, at the same handle, and the hub's routing table left holding what the
 * station sells *today*.
 *
 * Every assertion here is over one of exactly two things: **what a real app
 * answered over HTTP**, or **what the fake operator surface ended up
 * holding**. Nothing asserts that a function was called, nothing reaches into
 * the roster's on-disk layout, and nothing imports the response shape it
 * checks — a change to what a broadcaster depends on has to fail this file
 * rather than agree with itself.
 *
 * **The lapse rule this file pins down, because the issue did not settle it.**
 * A purchase *adds* a period rather than replacing one:
 *
 * ```
 *   lapsesAt = max(now, the lapse already held) + the slot period
 * ```
 *
 * Resetting to `now + period` would take back the time a broadcaster had
 * already paid for, so a hub would be teaching every one of them to renew at
 * the last possible minute or lose the difference. Extending from the held
 * lapse *alone* would do the opposite once a slot has lapsed: a station that
 * went dark for a month and came back would have that month credited to it.
 * `max` is the only reading that cheats nobody, and both halves of it are
 * asserted below — the early renewal stacks exactly one period onto the lapse
 * it already had, and the lapsed one is measured from now.
 *
 * **And the thing a destructive write has to prove.** A hub's routing table is
 * shared by every broadcaster it admitted, and a runtime row is upserted by
 * prefix rather than owned — only a *config* row is protected, by the
 * connector's own `409`. So this file boots two broadcasters against one hub
 * and asserts that a renewal by one of them removes nothing of the other's,
 * naming every path the app ever sent a `DELETE` to.
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

/** What a broadcaster reads back from a purchase, written out rather than imported. */
interface BoughtBody {
  prefix: string;
  label: string;
  lapsesAt: number;
  slotPeriodSeconds: number;
  routes: { prefix: string; price: string }[];
  peering: { localLabel: string; channel: { id: string; status: string } };
}

/** The quote, only as far as this file reads it. */
interface QuoteBody {
  prefix: string;
  label: string;
  slotsHeld: number;
  slot: { lapsesAt: number } | null;
}

const HUB_ADDRESS = 'g.toon.slopmachine.testhub';

/** The ladder the suite's station starts out selling. */
const LADDER: readonly FakeStationRung[] = [
  { rung: 'now', price: '50' },
  { rung: 'audio', price: '200' },
  { rung: '480p', price: '1000' },
  { rung: '720p', price: '2000' },
];

/** What the hub retains for carrying one packet. */
const CARRIAGE = 10;

/** The apex the committed station bundle ships, before a hub grants a real one. */
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
  const dir = mkdtempSync(join(tmpdir(), 'slot-renewal-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * A throwaway operator key pair and bearer token, mounted at real files the
 * way a hub's compose file mounts the real things. Fresh and random per boot
 * — no credential literal belongs in this repository, not even a test's.
 */
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
async function boot(config: Partial<SlotAppConfig> = {}): Promise<Hub> {
  const dataDir = freshDir();
  const mounted = mountCredentials(dataDir);

  const operator = await startFakeOperatorSurface({
    writeKeys: [publicKeyOf(mounted.seed)],
    bearerToken: mounted.bearerToken,
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

/**
 * What a broadcaster actually does before their first purchase: pull a quote,
 * write the prefix it granted into their own station's configuration, boot.
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

async function buy(
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

/** Every path the app has sent a removal to, in the order it sent them. */
function removals(operator: FakeOperatorSurface): string[] {
  return operator
    .writes()
    .filter((write) => write.method === 'DELETE')
    .map((write) => write.path);
}

function sleep(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, ms));
}

// ---------- One slot, at the same address ----------

describe('buying again is renewing', () => {
  it('extends the slot the payer already holds rather than creating a second', async () => {
    const { app } = await boot({ slotPeriodSeconds: 900 });
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    const first = await bought(app, payer, station);
    const renewed = await bought(app, payer, station);

    // One slot for this payer, not two. Counted the way a hub operator would
    // count it: by asking the hub how many it holds.
    expect((await quote(app, payer)).slotsHeld).toBe(1);
    expect(renewed.lapsesAt).toBeGreaterThan(first.lapsesAt);
  });

  it('grants the same prefix and the same handle across a renewal', async () => {
    const { app } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    const granted = await configured(app, payer, station);

    const first = await bought(app, payer, station);
    const renewed = await bought(app, payer, station);

    // The address a broadcaster printed on their page keeps working, which is
    // the whole reason the handle is derived from the payer rather than
    // chosen.
    expect(first.prefix).toBe(granted);
    expect(renewed.prefix).toBe(granted);
    expect(renewed.label).toBe(first.label);
    expect((await quote(app, payer)).prefix).toBe(granted);
  });

  it('adds a period to the lapse it already held, so renewing early costs nothing', async () => {
    const { app } = await boot({ slotPeriodSeconds: 900 });
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    const first = await bought(app, payer, station);
    const renewed = await bought(app, payer, station);

    // Exactly one period on top of the lapse already held — not a period from
    // now, which would silently take back every unused second of the first
    // purchase and teach broadcasters to renew at the last minute.
    expect(renewed.lapsesAt).toBe(first.lapsesAt + 900 * 1000);
    expect(renewed.slotPeriodSeconds).toBe(900);
  });

  it('measures from now once the slot has already lapsed, crediting no downtime', async () => {
    const { app } = await boot({ slotPeriodSeconds: 1 });
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    const first = await bought(app, payer, station);
    await sleep(1500);

    const before = Date.now();
    const renewed = await bought(app, payer, station);

    // A slot nobody renewed for longer than it lasted does not bank the
    // difference: coming back buys a period from now. Extending from the held
    // lapse alone would land at first.lapsesAt + 1000, which is already past.
    expect(renewed.lapsesAt).toBeGreaterThanOrEqual(before + 1000);
    expect(renewed.lapsesAt).toBeGreaterThan(first.lapsesAt + 1000);
  });

  it('answers with the new lapse time, and the quote agrees with it', async () => {
    const { app } = await boot({ slotPeriodSeconds: 900 });
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    await bought(app, payer, station);
    const renewed = await bought(app, payer, station);

    // The cheap address and the expensive one tell the same story: a
    // broadcaster deciding whether to renew again reads the number they were
    // just answered with.
    expect((await quote(app, payer)).slot).toEqual({
      lapsesAt: renewed.lapsesAt,
    });
  });

  it('finds the established peering rather than opening a second channel', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    const first = await bought(app, payer, station);
    const renewed = await bought(app, payer, station);

    // The retry-safety the peering write already had is exactly what makes a
    // repeat purchase a renewal rather than a second admission — and the
    // answer says which branch it took, so a second channel would be visible
    // in the hub's own output rather than on a block explorer later.
    expect(first.peering.channel.status).toBe('created');
    expect(renewed.peering.channel.status).toBe('found');
    expect(renewed.peering.channel.id).toBe(first.peering.channel.id);
    expect(operator.peerings()).toHaveLength(1);
  });
});

// ---------- The ladder, as it is today ----------

describe('a renewal re-reads the station and matches the table to it', () => {
  it('routes a rung the station has added since the last purchase', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    const prefix = await configured(app, payer, station);

    await bought(app, payer, station);

    // The broadcaster adds a top rung to their own connector and boots.
    station.publish([...LADDER, { rung: '1080p', price: '3500' }]);
    const renewed = await bought(app, payer, station);

    expect(operator.routes()).toEqual([
      { prefix: `${prefix}.now`, peer_id: renewed.label, price: 50 + CARRIAGE },
      {
        prefix: `${prefix}.audio`,
        peer_id: renewed.label,
        price: 200 + CARRIAGE,
      },
      {
        prefix: `${prefix}.480p`,
        peer_id: renewed.label,
        price: 1000 + CARRIAGE,
      },
      {
        prefix: `${prefix}.720p`,
        peer_id: renewed.label,
        price: 2000 + CARRIAGE,
      },
      {
        prefix: `${prefix}.1080p`,
        peer_id: renewed.label,
        price: 3500 + CARRIAGE,
      },
    ]);
    // Read afresh, both times: the price list is the station's own document
    // and not something the hub remembered.
    expect(station.reads()).toBe(2);
    expect(renewed.routes.map((route) => route.prefix)).toContain(
      `${prefix}.1080p`
    );
  });

  it('removes the route for a rung the station no longer publishes', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    const prefix = await configured(app, payer, station);

    await bought(app, payer, station);
    expect(operator.routes()).toHaveLength(4);

    // The broadcaster drops their two top rungs and boots.
    station.publish([
      { rung: 'now', price: '50' },
      { rung: 'audio', price: '200' },
    ]);
    const renewed = await bought(app, payer, station);

    // A write is an upsert, so nothing about rewriting the two survivors
    // removes the two that went. The hub's table ends up matching what the
    // station sells today rather than what it sold when it first bought in.
    expect(operator.routes().map((route) => route.prefix)).toEqual([
      `${prefix}.now`,
      `${prefix}.audio`,
    ]);
    expect(renewed.routes.map((route) => route.prefix)).toEqual([
      `${prefix}.now`,
      `${prefix}.audio`,
    ]);
    // And it was taken out by a real, signed removal against the operator
    // surface, at the address the connector removes a peer route at.
    expect(removals(operator).sort()).toEqual([
      `/routes/peers/${prefix}.480p`,
      `/routes/peers/${prefix}.720p`,
    ]);
    expect(operator.refusals()).toEqual([]);
  });

  it('removes nothing when the ladder has not changed', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    await bought(app, payer, station);
    await bought(app, payer, station);

    expect(operator.routes()).toHaveLength(4);
    expect(removals(operator)).toEqual([]);
  });
});

// ---------- Somebody else's address ----------

describe('a renewal can only ever touch the caller’s own address space', () => {
  it('leaves another broadcaster’s rows alone, even a shrinking one', async () => {
    const { app, operator } = await boot();

    // The first broadcaster buys a full ladder and is left alone from here.
    const theirs = await bootStation();
    const theirPayer = evmPayer();
    const theirPrefix = await configured(app, theirPayer, theirs);
    await bought(app, theirPayer, theirs);

    // The second buys — from a station that also publishes every one of the
    // first broadcaster's addresses, which is the shape of the attempt: a
    // node claiming to terminate somebody else's prefixes so that a renewal
    // computed from the wrong set would take them out.
    const ours = await bootStation({
      alsoPublishes: LADDER.map((rung) => ({
        prefix: `${theirPrefix}.${rung.rung}`,
        price: '1',
      })),
    });
    const ourPayer = evmPayer();
    const ourPrefix = await configured(app, ourPayer, ours);
    await bought(app, ourPayer, ours);

    expect(ourPrefix).not.toBe(theirPrefix);
    expect(operator.routes()).toHaveLength(8);

    // Now we drop our whole ladder to one rung. Everything else beneath OUR
    // grant goes; nothing beneath theirs is even a candidate.
    ours.publish([{ rung: 'now', price: '50' }]);
    await bought(app, ourPayer, ours);

    expect(operator.routes().map((route) => route.prefix)).toEqual([
      `${theirPrefix}.now`,
      `${theirPrefix}.audio`,
      `${theirPrefix}.480p`,
      `${theirPrefix}.720p`,
      `${ourPrefix}.now`,
    ]);

    // The strongest form of it: every removal the app has ever sent named an
    // address beneath the caller's own granted prefix, and none of them named
    // one beneath anybody else's.
    for (const path of removals(operator)) {
      expect(path.startsWith(`/routes/peers/${ourPrefix}.`)).toBe(true);
    }
    // And the first broadcaster still holds their slot, unshortened.
    expect((await quote(app, theirPayer)).slot).not.toBeNull();
  });

  it('takes nothing out when the caller has never held a row', async () => {
    const { app, operator } = await boot();

    const theirs = await bootStation();
    const theirPayer = evmPayer();
    await configured(app, theirPayer, theirs);
    await bought(app, theirPayer, theirs);

    const ours = await bootStation();
    const ourPayer = evmPayer();
    await configured(app, ourPayer, ours);
    await bought(app, ourPayer, ours);

    // A first purchase reads the hub's table and finds nothing of its own in
    // it. A table full of other people's rows is not an invitation.
    expect(operator.routes()).toHaveLength(8);
    expect(removals(operator)).toEqual([]);
  });
});

// ---------- The hub's own surface, on the removal ----------

describe('a removal the hub’s own surface will not take', () => {
  it('names the hub, and leaves the slot the broadcaster already held', async () => {
    const { app, operator } = await boot({ slotPeriodSeconds: 900 });
    const station = await bootStation();
    const payer = evmPayer();
    const prefix = await configured(app, payer, station);

    const first = await bought(app, payer, station);

    station.publish([{ rung: 'now', price: '50' }]);
    // Every attempt at removing the first dropped row fails transiently.
    operator.failNextWrites(3, `/routes/peers/${prefix}.audio`);

    const res = await buy(app, payer, station.url);
    const body = (await res.json()) as { error: string; message: string };

    expect(res.status).toBe(503);
    expect(body.error).toBe('routes_not_written');
    expect(body.message).toMatch(/hub operator/);

    // The renewal did not take effect, so the broadcaster is left holding
    // exactly the slot and the lapse they already had — never a shortened
    // one — and retrying is safe.
    expect((await quote(app, payer)).slot).toEqual({
      lapsesAt: first.lapsesAt,
    });
  });
});
