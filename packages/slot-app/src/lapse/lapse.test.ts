/**
 * A slot nobody renewed lapses, and the hub takes it back out itself.
 *
 * Every assertion here is over one of exactly two things: **what a real app
 * answered over HTTP**, or **what the fake operator surface ended up
 * holding**. Nothing asserts that a function was called, nothing reaches into
 * the roster's on-disk layout, and nothing imports the response shape it
 * checks.
 *
 * **There are no fake timers in this file and there must never be.** The slot
 * period and the sweep interval are ordinary configuration, so the suite sets
 * both to a second or two and waits — the same trick `--ingest-idle-seconds`
 * established on the station side. What runs here is the rule a hub runs, at
 * a value a hub operator could set; a fake clock would be a different rule
 * that happens to share a name with it.
 *
 * **The teardown order is not asserted by reading the code.** The fake
 * operator surface enforces the connector's own referential rule — a runtime
 * peering cannot be removed while a runtime route still forwards to it,
 * `PeerRouteTableError::PeerInUse`, a `409` — so a hub that released the
 * peering first would be refused and would leave it standing. A test that
 * finds the peering gone has therefore found a teardown that did the routes
 * first. One block below proves that rule is live rather than decorative, by
 * asking the surface to release a peering whose routes are still in place and
 * watching it refuse.
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
import { createWriteSigner } from '../operator/write-signature.js';
import { releasePeering } from '../peering/peering.js';
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

/** The ladder the suite's station sells. */
const LADDER: readonly FakeStationRung[] = [
  { rung: 'now', price: '50' },
  { rung: 'audio', price: '200' },
  { rung: '480p', price: '1000' },
];

/** What the hub retains for carrying one packet. */
const CARRIAGE = 10;

/** The apex the committed station bundle ships, before a hub grants a real one. */
const PLACEHOLDER_APEX = 'g.toon.slopmachine.demo';

/**
 * The slot period the lapsing hubs run with, in seconds.
 *
 * A whole number of seconds, and the same setting a hub operator writes — one
 * second is a legal `TOON_SLOT_PERIOD_SECONDS`, not a test-only value.
 */
const PERIOD_SECONDS = 1;

/** How often those hubs walk their roster, in seconds. Also ordinary configuration. */
const SWEEP_SECONDS = 1;

/** How long a test will wait for a sweep to have happened before giving up. */
const PATIENCE_MS = 20_000;

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

interface Mounted {
  seed: string;
  writeKeyFile: string;
  bearerToken: string;
  bearerTokenFile: string;
}

interface Hub {
  app: SlotAppInstance;
  operator: FakeOperatorSurface;
  mounted: Mounted;
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slot-lapse-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * A throwaway operator key pair and bearer token, mounted at real files the
 * way a hub's compose file mounts the real things. Fresh and random per boot
 * — no credential literal belongs in this repository, not even a test's.
 */
function mountCredentials(dir: string): Mounted {
  const seed = randomBytes(32).toString('hex');
  const writeKeyFile = join(dir, 'operator-signing.key');
  writeFileSync(writeKeyFile, `${seed}\n`, { mode: 0o600 });

  const bearerToken = randomBytes(32).toString('hex');
  const bearerTokenFile = join(dir, 'operator-bearer.token');
  writeFileSync(bearerTokenFile, `${bearerToken}\n`, { mode: 0o600 });

  return { seed, writeKeyFile, bearerToken, bearerTokenFile };
}

/**
 * Boot a real hub against a fake operator surface that verifies for real.
 *
 * The period and the sweep are short here because this file is about lapsing;
 * a test that wants a hub which cannot lapse during it says so.
 */
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
    slotPeriodSeconds: PERIOD_SECONDS,
    lapseSweepSeconds: SWEEP_SECONDS,
    operatorUrl: operator.url,
    // This suite is a local topology: the fake station connector serves its
    // self-description over plaintext on loopback, with no certificate
    // anywhere. A hub with a public name reads https only — see
    // TOON_ALLOW_PLAINTEXT_STATION_URLS, whose default is false.
    allowPlaintextStationUrls: true,
    operatorWriteKeyFile: mounted.writeKeyFile,
    operatorBearerTokenFile: mounted.bearerTokenFile,
    ...config,
  });
  running.push(app);

  return { app, operator, mounted };
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

async function bought(
  app: SlotAppInstance,
  payer: string,
  connector: FakeStationConnector
): Promise<BoughtBody> {
  const res = await fetch(appUrl(app, '/buy'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-toon-payer': payer,
      'x-toon-amount': '1000000',
      'x-toon-chain': 'evm',
    },
    body: JSON.stringify({ stationUrl: connector.url }),
  });
  const answered: unknown = await res.json();
  if (res.status !== 200) {
    throw new Error(
      `expected a purchase, got ${String(res.status)}: ${JSON.stringify(answered)}`
    );
  }
  return answered as BoughtBody;
}

/** Every write the app made, as `METHOD path`, in the order it made them. */
function writeLog(operator: FakeOperatorSurface): string[] {
  return operator.writes().map((write) => `${write.method} ${write.path}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, ms));
}

/**
 * Wait for something the hub does on its own initiative, polling.
 *
 * Polling rather than a fixed sleep because the thing being waited for is a
 * real interval firing against a real operator surface, and a test that slept
 * exactly one period would be a test that failed on a loaded box. It waits
 * for the state, and gives up loudly.
 */
async function until(
  what: string,
  ready: () => boolean | Promise<boolean>,
  patienceMs = PATIENCE_MS
): Promise<void> {
  const deadline = Date.now() + patienceMs;
  for (;;) {
    if (await ready()) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${String(patienceMs)}ms waiting: ${what}`
      );
    }
    await sleep(50);
  }
}

// ---------- The hub takes a dead station back out by itself ----------

describe('a slot nobody renewed lapses', () => {
  it('is torn down by the hub on its own initiative, with no request to trigger it', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    const slot = await bought(app, payer, station);
    expect(operator.peerings().map((peering) => peering.id)).toEqual([
      slot.label,
    ]);
    expect(operator.routes()).toHaveLength(LADDER.length);

    // Nothing below speaks to the app. The only thing that happens between
    // the purchase and the assertion is time passing.
    await until(
      'the hub to take the lapsed peering back out',
      () => operator.peerings().length === 0
    );

    // The hub's routing table holds no route and no peering for that station.
    expect(operator.routes()).toEqual([]);
    expect(operator.peerings()).toEqual([]);
  });

  it('removes every route before it releases the peering', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    const granted = await configured(app, payer, station);

    const slot = await bought(app, payer, station);
    await until(
      'the hub to finish the teardown',
      () => operator.peerings().length === 0
    );

    const log = writeLog(operator);
    const releasedAt = log.indexOf(`DELETE /peers/${slot.label}`);
    const removals = log
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.startsWith('DELETE /routes/peers/'));

    // The peering went, which on a surface that enforces the connector's own
    // referential rule is only reachable by having taken the routes out
    // first. Said as an ordering assertion too, so a failure names the fault
    // rather than only its symptom.
    expect(releasedAt).toBeGreaterThan(-1);
    expect(removals).toHaveLength(LADDER.length);
    for (const { entry, index } of removals) {
      expect({ entry, before: index < releasedAt }).toEqual({
        entry,
        before: true,
      });
    }

    // And every rung the station sold was one of them — a teardown that left
    // one row behind would have been refused the release.
    expect(
      removals.map(({ entry }) =>
        decodeURIComponent(entry.slice('DELETE /routes/peers/'.length))
      )
    ).toEqual(
      expect.arrayContaining(LADDER.map((rung) => `${granted}.${rung.rung}`))
    );
  });

  it('is refused the release while a route still forwards to the peering', async () => {
    // The one block in this file that does not speak to the app: it speaks to
    // the FAKE OPERATOR SURFACE, to prove the rule the assertions above lean
    // on is live rather than decorative. If this surface would release a
    // peering with routes still pointing at it, "the peering is gone" would
    // say nothing about the order anything happened in.
    const { app, operator, mounted } = await boot({
      slotPeriodSeconds: 3600,
    });
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);
    const slot = await bought(app, payer, station);

    await expect(
      releasePeering(
        {
          policy: {
            operatorUrl: operator.url,
            fee: CARRIAGE,
            maxPacketAmount: 1,
          },
          signer: createWriteSigner(mounted.seed),
        },
        { localLabel: slot.label }
      )
    ).rejects.toThrow(/409/);

    // Refused, and nothing removed: the peering and its routes both stand.
    expect(operator.peerings().map((peering) => peering.id)).toEqual([
      slot.label,
    ]);
    expect(operator.routes()).toHaveLength(LADDER.length);
  });

  it('leaves the peering standing when the routes could not be taken out, and finishes on the next sweep', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    const granted = await configured(app, payer, station);

    const slot = await bought(app, payer, station);

    // The hub's own routing table refuses every removal the first sweep
    // attempts. A teardown that could not finish its first half must not
    // start its second — the peering has to still be there afterwards.
    operator.failNextWrites(
      99,
      `/routes/peers/${encodeURIComponent(`${granted}.now`)}`
    );

    await until('the first sweep to have tried and failed', () =>
      writeLog(operator).some((entry) => entry.startsWith('DELETE /routes/'))
    );
    expect(operator.peerings().map((peering) => peering.id)).toEqual([
      slot.label,
    ]);

    // The slot is still held, because the hub still has work to do about it.
    expect((await quote(app, payer)).slot).not.toBeNull();

    // Let the removals through again; the next sweep finishes the job.
    operator.failNextWrites(0);
    await until(
      'a later sweep to complete the teardown',
      () => operator.peerings().length === 0
    );
    expect(operator.routes()).toEqual([]);
    expect((await quote(app, payer)).slot).toBeNull();
  });
});

// ---------- What a broadcaster sees afterwards ----------

describe('after a lapse', () => {
  it('the quote reports the caller as holding no slot', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);

    await bought(app, payer, station);
    expect((await quote(app, payer)).slot).not.toBeNull();

    await until(
      'the hub to tear the slot down',
      () => operator.peerings().length === 0
    );

    const after = await quote(app, payer);
    expect(after.slot).toBeNull();
    expect(after.slotsHeld).toBe(0);
  });

  it('a re-buy grants the same handle and the same prefix as before', async () => {
    const { app, operator } = await boot();
    const station = await bootStation();
    const payer = evmPayer();
    const granted = await configured(app, payer, station);

    const first = await bought(app, payer, station);
    await until(
      'the hub to tear the slot down',
      () => operator.peerings().length === 0
    );

    // Coming back after a break is a re-buy at the same address, not starting
    // over at a new one — which is the whole reason the handle is derived
    // from the payer rather than assigned in sequence.
    const again = await bought(app, payer, station);
    expect(again.label).toBe(first.label);
    expect(again.prefix).toBe(granted);
    expect((await quote(app, payer)).prefix).toBe(granted);

    // And the hub is carrying them again: a fresh peering under the same
    // label, with every rung routed beneath the same prefix.
    expect(operator.peerings().map((peering) => peering.id)).toEqual([
      first.label,
    ]);
    expect(
      operator
        .routes()
        .map((route) => route.prefix)
        .sort()
    ).toEqual(LADDER.map((rung) => `${granted}.${rung.rung}`).sort());
  });

  it('takes out only the lapsed broadcaster, and leaves the one who renewed alone', async () => {
    // One hub, two broadcasters, and only one of them renews. A hub's routing
    // table is shared by everybody it admitted and a runtime row carries no
    // owner for the connector to check, so a teardown that reached past its
    // own grant would take a paying station off the air.
    const { app, operator } = await boot({ slotPeriodSeconds: 5 });
    const staying = await bootStation();
    const leaving = await bootStation();

    const stayingPayer = evmPayer();
    const leavingPayer = evmPayer();
    const stayingPrefix = await configured(app, stayingPayer, staying);
    const leavingPrefix = await configured(app, leavingPayer, leaving);

    const stayingSlot = await bought(app, stayingPayer, staying);
    const leavingSlot = await bought(app, leavingPayer, leaving);
    expect(operator.routes()).toHaveLength(LADDER.length * 2);

    // One of them renews, well inside the period. The other never comes back.
    await sleep(2000);
    await bought(app, stayingPayer, staying);

    await until(
      "the hub to take the lapsed broadcaster's peering back out",
      () =>
        !operator.peerings().some((peering) => peering.id === leavingSlot.label)
    );

    // The one who renewed is untouched: peered, and every rung still routed.
    expect(operator.peerings().map((peering) => peering.id)).toEqual([
      stayingSlot.label,
    ]);
    expect([...operator.routes().map((route) => route.prefix)].sort()).toEqual(
      [...LADDER.map((rung) => `${stayingPrefix}.${rung.rung}`)].sort()
    );

    // And nothing outside the lapsed broadcaster's own grant was ever sent a
    // removal — asserted by naming every path the app deleted, not by
    // counting them.
    for (const entry of writeLog(operator).filter((line) =>
      line.startsWith('DELETE /routes/peers/')
    )) {
      const prefix = decodeURIComponent(
        entry.slice('DELETE /routes/peers/'.length)
      );
      expect({
        prefix,
        beneath: prefix.startsWith(`${leavingPrefix}.`),
      }).toEqual({ prefix, beneath: true });
    }
    expect(
      writeLog(operator).filter((line) => line.startsWith('DELETE /peers/'))
    ).toEqual([`DELETE /peers/${leavingSlot.label}`]);
  });
});

// ---------- A live slot is never torn down ----------

describe('the ticker leaves a live slot alone', () => {
  it('keeps the routes and the peering across a renewal made before the lapse', async () => {
    const { app, operator } = await boot({ slotPeriodSeconds: 4 });
    const station = await bootStation();
    const payer = evmPayer();
    const granted = await configured(app, payer, station);

    const first = await bought(app, payer, station);

    // Renew comfortably inside the period, then wait past the lapse the first
    // purchase alone would have had. Several sweeps run in that window; none
    // of them may touch this slot.
    await sleep(1500);
    const renewed = await bought(app, payer, station);
    expect(renewed.lapsesAt).toBeGreaterThan(first.lapsesAt);

    await until(
      'the original lapse to have passed',
      () => Date.now() > first.lapsesAt + SWEEP_SECONDS * 1000 * 2
    );

    // Still peered, still routed, still on the roster.
    expect(operator.peerings().map((peering) => peering.id)).toEqual([
      first.label,
    ]);
    expect(
      operator
        .routes()
        .map((route) => route.prefix)
        .sort()
    ).toEqual(LADDER.map((rung) => `${granted}.${rung.rung}`).sort());
    expect((await quote(app, payer)).slot?.lapsesAt).toBe(renewed.lapsesAt);
  });

  it('makes no operator write at all while nothing has lapsed', async () => {
    const { app, operator } = await boot({ slotPeriodSeconds: 3600 });
    const station = await bootStation();
    const payer = evmPayer();
    await configured(app, payer, station);
    await bought(app, payer, station);

    const afterPurchase = writeLog(operator).length;
    await sleep(SWEEP_SECONDS * 1000 * 3);

    // A sweep over a roster with nothing lapsed reads nothing and writes
    // nothing: it is a walk over rows already in memory.
    expect(writeLog(operator)).toHaveLength(afterPurchase);
  });
});

// ---------- The period and the sweep are configuration ----------

describe('the slot period and the sweep interval are ordinary configuration', () => {
  it('defaults to a thirty-day period swept every minute', async () => {
    const { app } = await boot({
      slotPeriodSeconds: undefined,
      lapseSweepSeconds: undefined,
    });

    // The values a hub runs with when its operator sets neither. Literals
    // rather than the module's own constants: a change to what a hub does by
    // default has to fail this test rather than agree with itself.
    expect(app.config.policy.slotPeriodSeconds).toBe(30 * 24 * 60 * 60);
    expect(app.config.lapseSweepSeconds).toBe(60);
  });

  it('refuses to start on a sweep interval that would never reclaim anything', async () => {
    // There is deliberately no value that turns the sweep off. A hub that
    // never reclaims a dead station's peering only ever commits more
    // collateral, which is the bug the ticker exists to close.
    await expect(boot({ lapseSweepSeconds: 0 })).rejects.toThrow(
      /TOON_LAPSE_SWEEP_SECONDS/
    );
    await expect(boot({ lapseSweepSeconds: 'soon' })).rejects.toThrow(
      /TOON_LAPSE_SWEEP_SECONDS/
    );
  });
});
