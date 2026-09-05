/**
 * The cap is a bound, not a hint: a hub full of slots admits nobody new, and
 * says so before it writes anything.
 *
 * `TOON_SLOT_CAP` is the hub's **capital** bound. Every admission opens a
 * payment channel the hub fronts collateral toward, so the roster is a
 * balance-sheet commitment that grows linearly with its own size and with
 * nothing else, and this number is the only thing bounding it. A cap the
 * quote merely *reported* would bound nothing at all — the buyer who ignored
 * `hasCapacity: false` would be admitted anyway — which is what this file
 * exists to make impossible.
 *
 * **And the other half, which matters more.** A renewal by somebody who
 * already holds a slot is **always** admitted, at the cap and over it.
 * Renewing opens no channel and writes no new row, so it adds nothing to the
 * commitment the cap bounds; refusing one would take a paying broadcaster off
 * the air for renewing on time, and would leave a hub whose cap was lowered
 * beneath its own roster unable to keep any of the stations it is already
 * carrying. Both directions are asserted here, the second one twice — at the
 * cap, and over it.
 *
 * Every assertion is over what a real app answered over HTTP or what the fake
 * operator surface ended up holding. The refusal is asserted to have cost the
 * hub **no operator write**, because a refusal that had already opened a
 * channel would be the cap failing at the only thing it is for.
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
}

/** A refusal, as the caller reads it. */
interface RefusalBody {
  error: string;
  message: string;
}

/** The quote, only as far as this file reads it. */
interface QuoteBody {
  hasCapacity: boolean;
  slotCap: number;
  slotsHeld: number;
  slot: { lapsesAt: number } | null;
}

const HUB_ADDRESS = 'g.toon.slopmachine.testhub';

const LADDER: readonly FakeStationRung[] = [
  { rung: 'now', price: '50' },
  { rung: 'audio', price: '200' },
];

const CARRIAGE = 10;
const PLACEHOLDER_APEX = 'g.toon.slopmachine.demo';

/**
 * A long period, so nothing in this file lapses while it runs. The cap is
 * about admission, and a slot disappearing underneath an assertion would be a
 * different test.
 */
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

interface Mounted {
  seed: string;
  writeKeyFile: string;
  bearerToken: string;
  bearerTokenFile: string;
}

interface Hub {
  app: SlotAppInstance;
  operator: FakeOperatorSurface;
  /** Everything a second boot over the same hub needs. */
  reboot(config?: Partial<SlotAppConfig>): Promise<SlotAppInstance>;
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slot-cap-'));
  tempDirs.push(dir);
  return dir;
}

/** Throwaway credentials, mounted at real files. Fresh and random per hub. */
function mountCredentials(dir: string): Mounted {
  const seed = randomBytes(32).toString('hex');
  const writeKeyFile = join(dir, 'operator-write.key');
  writeFileSync(writeKeyFile, `${seed}\n`, { mode: 0o600 });

  const bearerToken = randomBytes(32).toString('hex');
  const bearerTokenFile = join(dir, 'operator-bearer.token');
  writeFileSync(bearerTokenFile, `${bearerToken}\n`, { mode: 0o600 });

  return { seed, writeKeyFile, bearerToken, bearerTokenFile };
}

/**
 * Boot a real hub against a fake operator surface that verifies for real, and
 * hand back the means to bring the same hub up again on a different policy —
 * which is how a cap that an operator *lowered* beneath their own roster is
 * reached without inventing a way to write one.
 */
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
      peeringFee: CARRIAGE,
      slotPeriodSeconds: PERIOD_SECONDS,
      operatorUrl: operator.url,
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
      // Wait out the second the old process signed in. An accepted signature
      // is spent and Ed25519 is deterministic, so the only part of a repeated
      // write's signature base that can honestly differ is its `created`
      // second — and a signer that has just been constructed does not
      // remember what its predecessor signed. A hub restarted and asked to
      // repeat an identical write inside one second is refused as a replay;
      // it is a real gap, it belongs to the signer rather than to the cap,
      // and this test is not the place to hide it.
      await new Promise((wake) =>
        setTimeout(wake, 1000 - (Date.now() % 1000) + 50)
      );
      return restarted;
    },
  };
}

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

/** Pull a quote and write the granted prefix into the station, as a broadcaster does. */
async function configured(
  app: SlotAppInstance,
  payer: string,
  connector: FakeStationConnector
): Promise<void> {
  const res = await fetch(appUrl(app, '/quote'), {
    headers: { 'x-toon-payer': payer, 'x-toon-amount': '50' },
  });
  const { prefix } = (await res.json()) as { prefix: string };
  connector.terminateAt(prefix);
}

async function buy(
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

/** A broadcaster who quotes, configures and buys, in one go. */
async function admit(
  app: SlotAppInstance,
  connector: FakeStationConnector
): Promise<{ payer: string; slot: BoughtBody }> {
  const payer = evmPayer();
  await configured(app, payer, connector);
  return { payer, slot: await bought(app, payer, connector) };
}

// ---------- A hub at its cap admits nobody new ----------

describe('the slot cap bounds the roster', () => {
  it('refuses a new slot once the roster is at the cap', async () => {
    const hub = await boot({ slotCap: 1 });
    const first = await bootStation();
    const second = await bootStation();

    await admit(hub.app, first);

    const latecomer = evmPayer();
    await configured(hub.app, latecomer, second);

    // The quote told them, at a floor price, before they spent the slot
    // price. That is the warning the refusal below is honest about having
    // given.
    const warned = await quote(hub.app, latecomer);
    expect(warned.hasCapacity).toBe(false);
    expect(warned.slotCap).toBe(1);
    expect(warned.slotsHeld).toBe(1);

    const res = await buy(hub.app, latecomer, second);
    const refusal = (await res.json()) as RefusalBody;
    expect(res.status).toBe(503);
    expect(refusal.error).toBe('at_capacity');
    // The message says whose problem it is not, points at the cheap address,
    // and says a renewal is never refused for this.
    expect(refusal.message).toMatch(/nothing about your node/i);
    expect(refusal.message).toMatch(/hasCapacity/);
    expect(refusal.message).toMatch(/renewing it is never refused/i);
  });

  it('refuses before any operator write, so a hub at its cap opens no channel', async () => {
    const hub = await boot({ slotCap: 1 });
    const first = await bootStation();
    const second = await bootStation();

    const admitted = await admit(hub.app, first);
    const writesAfterAdmission = hub.operator.writes().length;

    const latecomer = evmPayer();
    await configured(hub.app, latecomer, second);
    await buy(hub.app, latecomer, second);

    // Not one write. A refusal that had already established the peering would
    // be the cap failing at the only thing it is for: the collateral is
    // committed by `POST /peers`, not by the roster row.
    expect(hub.operator.writes()).toHaveLength(writesAfterAdmission);
    expect(hub.operator.peerings().map((peering) => peering.id)).toEqual([
      admitted.slot.label,
    ]);
    // And the hub still counts one slot, so the refusal recorded nothing.
    expect((await quote(hub.app, latecomer)).slotsHeld).toBe(1);
  });

  it('admits nobody at all on a cap of zero, which is a policy an operator may state', async () => {
    const hub = await boot({ slotCap: 0 });
    const station = await bootStation();
    const payer = evmPayer();
    await configured(hub.app, payer, station);

    const res = await buy(hub.app, payer, station);
    expect(res.status).toBe(503);
    expect(((await res.json()) as RefusalBody).error).toBe('at_capacity');
    expect(hub.operator.writes()).toEqual([]);
    expect(hub.operator.peerings()).toEqual([]);
  });

  it('admits the next buyer once a slot has been freed', async () => {
    // A cap is a bound on how many exist at once, not a queue that closes.
    const hub = await boot({
      slotCap: 1,
      slotPeriodSeconds: 1,
      lapseSweepSeconds: 1,
    });
    const first = await bootStation();
    const second = await bootStation();

    await admit(hub.app, first);

    const latecomer = evmPayer();
    await configured(hub.app, latecomer, second);
    expect((await buy(hub.app, latecomer, second)).status).toBe(503);

    // Nobody renews the first slot, and the hub takes it back out itself.
    const deadline = Date.now() + 20_000;
    for (;;) {
      if ((await quote(hub.app, latecomer)).hasCapacity) break;
      if (Date.now() > deadline) throw new Error('the slot never lapsed');
      await new Promise((wake) => setTimeout(wake, 50));
    }

    const admitted = await bought(hub.app, latecomer, second);
    expect(admitted.label).not.toBe('');
    expect((await quote(hub.app, latecomer)).slotsHeld).toBe(1);
  });
});

// ---------- A renewal is never refused for the cap ----------

describe('a payer who already holds a slot can always renew', () => {
  it('renews at the cap, where a new buyer would be refused', async () => {
    const hub = await boot({ slotCap: 1 });
    const mine = await bootStation();
    const theirs = await bootStation();

    const holder = await admit(hub.app, mine);

    // The hub is full: a new buyer is refused.
    const latecomer = evmPayer();
    await configured(hub.app, latecomer, theirs);
    expect((await buy(hub.app, latecomer, theirs)).status).toBe(503);

    // And the broadcaster already on the roster renews anyway. Refusing this
    // would take a paying station off the air for being punctual, and the
    // renewal opens no channel the cap could be bounding.
    const renewed = await bought(hub.app, holder.payer, mine);
    expect(renewed.label).toBe(holder.slot.label);
    expect(renewed.prefix).toBe(holder.slot.prefix);
    expect(renewed.lapsesAt).toBeGreaterThan(holder.slot.lapsesAt);
    expect((await quote(hub.app, holder.payer)).slotsHeld).toBe(1);
  });

  it('renews when the operator has lowered the cap beneath the roster', async () => {
    // The over-cap case, reached the way a hub operator reaches it: two
    // broadcasters admitted under a cap of two, then the cap cut to one and
    // the hub brought back up. Both are now over a bound neither of them
    // crossed, and neither may be evicted for it — a cap that shrank is a
    // door that closed, not a hub that throws out the stations it is already
    // carrying. It shrinks back by lapses.
    const hub = await boot({ slotCap: 2 });
    const oneStation = await bootStation();
    const twoStation = await bootStation();

    const one = await admit(hub.app, oneStation);
    const two = await admit(hub.app, twoStation);

    const lowered = await hub.reboot({ slotCap: 1 });
    const over = await quote(lowered, one.payer);
    expect(over.slotsHeld).toBe(2);
    expect(over.slotCap).toBe(1);
    expect(over.hasCapacity).toBe(false);

    // Both holders renew, over the cap, and keep their own addresses.
    for (const [holder, station] of [
      [one, oneStation],
      [two, twoStation],
    ] as const) {
      const renewed = await bought(lowered, holder.payer, station);
      expect(renewed.prefix).toBe(holder.slot.prefix);
      expect(renewed.lapsesAt).toBeGreaterThan(holder.slot.lapsesAt);
    }
    expect((await quote(lowered, one.payer)).slotsHeld).toBe(2);

    // A new buyer is still refused, which is what makes the cap a bound
    // rather than a number nobody enforces.
    const third = await bootStation();
    const newcomer = evmPayer();
    await configured(lowered, newcomer, third);
    expect((await buy(lowered, newcomer, third)).status).toBe(503);
  });
});
