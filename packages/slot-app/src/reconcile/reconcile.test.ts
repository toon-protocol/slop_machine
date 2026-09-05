/**
 * The roster and the hub's routing table, made to agree at boot.
 *
 * Every block here boots the **real app twice against the same data directory
 * and the same fake operator surface** — the shape
 * `packages/station-origin/src/origin/reconnect.test.ts` set for continuity
 * across a restart — and asserts over what that surface ends up holding and
 * what the app answers over HTTP. Nothing reaches into the roster's on-disk
 * layout, the reconciliation's own bookkeeping or the signer. What a hub
 * operator can observe is what is checked: what the hub carries, and who it
 * says holds a slot.
 *
 * **The disagreements are made the way they really happen.** A row goes
 * missing by being removed over the operator surface with a real signed
 * `DELETE`, which is what a hub operator editing their own table by hand
 * actually does. A row exists that the roster does not know about because a
 * purchase was made to fail *after* the peering landed, which is what a crash
 * between the two writes leaves behind. Neither is simulated by reaching into
 * the app.
 *
 * **No fake timers, here or anywhere in this package.** The slot period and
 * the sweep interval are ordinary configuration; the blocks below set a period
 * of a second or two and a sweep long enough that only the *boot* can have
 * done the tearing down — which is how "downtime does not extend anybody's
 * slot" is told apart from "the ticker got round to it".
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
import type {
  FakeOperatorSurface,
  FakeOperatorSurfaceOptions,
} from '../operator/fake-operator-surface.js';
import { createWriteSigner } from '../operator/write-signature.js';
import { establishPeering } from '../peering/peering.js';
import {
  withdrawForwardedRoutes,
  writeForwardedRoutes,
} from '../peering/routes.js';
import { startFakeStationConnector } from '../peering/fake-station-connector.js';
import type {
  FakeStationConnector,
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
}

/** The roster address's answer, written out rather than imported. */
interface RosterBody {
  hubAddress: string;
  slotCap: number;
  slotsHeld: number;
  slots: {
    payer: string;
    label: string;
    prefix: string;
    lapsesAt: number;
  }[];
  timestamp: number;
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
 * A sweep interval no test here can reach.
 *
 * The point of most of this file is that the **boot** did the work. A hub
 * whose ticker could have fired inside a test would prove nothing about the
 * boot, so every hub below is configured to sweep once an hour and the tests
 * run in seconds.
 */
const NO_SWEEP_IN_TIME = 3600;

/** How long a test will wait for something to have happened before giving up. */
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

/**
 * One hub across restarts: its data directory, its credentials and its
 * operator surface all outlive the process, exactly as they do on a box.
 */
interface Hub {
  dataDir: string;
  mounted: Mounted;
  operator: FakeOperatorSurface;
  /** Boot the app against all of it. Called more than once, on purpose. */
  boot(config?: Partial<SlotAppConfig>): Promise<SlotAppInstance>;
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slot-reconcile-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * A throwaway operator key pair and bearer token, mounted at real files the
 * way a hub's compose file mounts the real things. Fresh and random per hub —
 * no credential literal belongs in this repository, not even a test's.
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
 * Stand up everything about a hub that survives its own process, so a test can
 * boot the app, stop it, and boot it again over the same state.
 */
async function hub(
  surfaceOptions: Partial<FakeOperatorSurfaceOptions> = {},
  defaults: Partial<SlotAppConfig> = {}
): Promise<Hub> {
  const dataDir = freshDir();
  const mounted = mountCredentials(dataDir);

  const operator = await startFakeOperatorSurface({
    writeKeys: [publicKeyOf(mounted.seed)],
    bearerToken: mounted.bearerToken,
    ...surfaceOptions,
  });
  surfaces.push(operator);

  return {
    dataDir,
    mounted,
    operator,
    async boot(config: Partial<SlotAppConfig> = {}) {
      const app = await startSlotApp({
        slotPort: 0,
        host: '127.0.0.1',
        dataDir,
        hubAddress: HUB_ADDRESS,
        peeringFee: CARRIAGE,
        lapseSweepSeconds: NO_SWEEP_IN_TIME,
        operatorUrl: operator.url,
        // This suite is a local topology: the fake station connector serves its
        // self-description over plaintext on loopback, with no certificate
        // anywhere. A hub with a public name reads https only — see
        // TOON_ALLOW_PLAINTEXT_STATION_URLS, whose default is false.
        allowPlaintextStationUrls: true,
        operatorWriteKeyFile: mounted.writeKeyFile,
        operatorBearerTokenFile: mounted.bearerTokenFile,
        ...defaults,
        ...config,
      });
      running.push(app);
      return app;
    },
  };
}

/** What the operator-surface calls in this file need: the hub's own credentials. */
function asOperator(one: Hub): {
  policy: { operatorUrl: string; fee: number; maxPacketAmount: number };
  signer: ReturnType<typeof createWriteSigner>;
  bearerToken: string;
} {
  return {
    policy: {
      operatorUrl: one.operator.url,
      fee: CARRIAGE,
      maxPacketAmount: 10_000_000,
    },
    signer: createWriteSigner(one.mounted.seed),
    bearerToken: one.mounted.bearerToken,
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

async function quotedPrefix(
  app: SlotAppInstance,
  payer: string
): Promise<string> {
  const res = await fetch(appUrl(app, '/quote'), {
    headers: { 'x-toon-payer': payer, 'x-toon-amount': '50' },
  });
  return ((await res.json()) as { prefix: string }).prefix;
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
  const prefix = await quotedPrefix(app, payer);
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

async function roster(app: SlotAppInstance): Promise<RosterBody> {
  const res = await fetch(appUrl(app, '/roster'));
  if (res.status !== 200) {
    throw new Error(`expected a roster, got ${String(res.status)}`);
  }
  return (await res.json()) as RosterBody;
}

/** Every write the app made, as `METHOD path`, in the order it made them. */
function writeLog(operator: FakeOperatorSurface): string[] {
  return operator.writes().map((write) => `${write.method} ${write.path}`);
}

/** What the hub is carrying, as `prefix -> peer_id`, sorted. */
function carrying(operator: FakeOperatorSurface): string[] {
  return operator
    .routes()
    .map((route) => `${route.prefix} -> ${route.peer_id}`)
    .sort();
}

function sleep(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, ms));
}

async function until(
  what: string,
  ready: () => boolean | Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + PATIENCE_MS;
  for (;;) {
    if (await ready()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting: ${what}`);
    }
    await sleep(50);
  }
}

// ---------- Downtime does not extend anybody's slot ----------

describe('a slot that lapsed while the process was down', () => {
  it('is torn down at boot rather than surviving the downtime', async () => {
    // A period of a second, and a sweep of an hour. Nothing but the boot can
    // possibly have done the teardown asserted below.
    const one = await hub({}, { slotPeriodSeconds: 1 });
    const station = await bootStation();
    const payer = evmPayer();

    const first = await one.boot();
    await configured(first, payer, station);
    const slot = await bought(first, payer, station);
    expect(one.operator.peerings().map((peering) => peering.id)).toEqual([
      slot.label,
    ]);
    expect(one.operator.routes()).toHaveLength(LADDER.length);

    // The hub goes down, and stays down past the lapse.
    await first.stop();
    await until(
      'the slot to have lapsed while nothing was running',
      () => Date.now() > slot.lapsesAt
    );

    // And comes back. By the time the port is bound the teardown is done: the
    // reconciliation runs before the listener does.
    const second = await one.boot();
    expect(one.operator.routes()).toEqual([]);
    expect(one.operator.peerings()).toEqual([]);
    expect((await roster(second)).slots).toEqual([]);
  });

  it('takes every route out before it releases the peering, at boot as at a tick', async () => {
    const one = await hub({}, { slotPeriodSeconds: 1 });
    const station = await bootStation();
    const payer = evmPayer();

    const first = await one.boot();
    await configured(first, payer, station);
    const slot = await bought(first, payer, station);
    await first.stop();
    await until('the slot to have lapsed', () => Date.now() > slot.lapsesAt);

    const before = writeLog(one.operator).length;
    await one.boot();

    // The surface enforces the connector's own referential rule — a peering
    // cannot be released while a runtime route still forwards to it — so a
    // released peering is by itself proof the routes went first. Said as an
    // ordering assertion too, so a failure names the fault and not the symptom.
    const atBoot = writeLog(one.operator).slice(before);
    const releasedAt = atBoot.indexOf(`DELETE /peers/${slot.label}`);
    expect(releasedAt).toBeGreaterThan(-1);
    const removals = atBoot
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.startsWith('DELETE /routes/peers/'));
    expect(removals).toHaveLength(LADDER.length);
    for (const { entry, index } of removals) {
      expect({ entry, before: index < releasedAt }).toEqual({
        entry,
        before: true,
      });
    }
  });

  it('leaves a slot with time left on it exactly where it was', async () => {
    const one = await hub({}, { slotPeriodSeconds: 3600 });
    const station = await bootStation();
    const payer = evmPayer();

    const first = await one.boot();
    const granted = await configured(first, payer, station);
    const slot = await bought(first, payer, station);
    const carried = carrying(one.operator);
    await first.stop();

    const second = await one.boot();

    // Nothing moved, and nothing was written to move it: a boot that finds
    // its own connector already carrying what the roster says is a boot that
    // makes no operator write at all.
    expect(carrying(one.operator)).toEqual(carried);
    expect(one.operator.peerings().map((peering) => peering.id)).toEqual([
      slot.label,
    ]);
    const answered = await roster(second);
    expect(answered.slots).toEqual([
      { payer, label: slot.label, prefix: granted, lapsesAt: slot.lapsesAt },
    ]);
  });
});

// ---------- What a crash left unwritten is written ----------

describe('a slot in the roster whose routes the connector is missing', () => {
  it('has them written back at boot, at the price they were granted at', async () => {
    const one = await hub({}, { slotPeriodSeconds: 3600 });
    const station = await bootStation();
    const payer = evmPayer();

    const first = await one.boot();
    const granted = await configured(first, payer, station);
    await bought(first, payer, station);
    await first.stop();

    // A hub operator removes one row by hand, over their own operator
    // surface, with a real signed DELETE — the disagreement this whole boot
    // path exists for, made the way it really happens.
    const dropped = `${granted}.audio`;
    await withdrawForwardedRoutes(asOperator(one), { grantedPrefix: dropped });
    expect(carrying(one.operator)).not.toContain(`${dropped} -> `);
    expect(one.operator.routes()).toHaveLength(LADDER.length - 1);

    await one.boot();

    // Back, pointing at the same peering and priced at the station's own
    // price plus this hub's carriage — the number the purchase granted, not a
    // number the boot guessed.
    expect(one.operator.routes()).toHaveLength(LADDER.length);
    const back = one.operator
      .routes()
      .find((route) => route.prefix === dropped);
    expect(back?.price).toBe(200 + CARRIAGE);
  });

  it('has its peering re-established at boot where that is what went missing', async () => {
    const one = await hub({}, { slotPeriodSeconds: 3600 });
    const station = await bootStation();
    const payer = evmPayer();

    const first = await one.boot();
    const granted = await configured(first, payer, station);
    const slot = await bought(first, payer, station);
    await first.stop();

    // The whole entry, taken out by hand: routes first, then the peering,
    // which is the only order the surface will accept.
    await withdrawForwardedRoutes(asOperator(one), {
      grantedPrefix: granted,
      localLabel: slot.label,
    });
    expect(one.operator.routes()).toEqual([]);

    await one.boot();

    // A broadcaster who is paid up is reachable again: peered, and every rung
    // they bought carried.
    expect(one.operator.peerings().map((peering) => peering.id)).toEqual([
      slot.label,
    ]);
    expect(carrying(one.operator)).toEqual(
      LADDER.map((rung) => `${granted}.${rung.rung} -> ${slot.label}`).sort()
    );
  });

  it('lets a restarted process repeat a write its predecessor just made', async () => {
    // The write the boot makes above is byte-identical to one the previous
    // process made moments earlier, and the connector's replay cache outlives
    // the app: it keys on the signature bytes, and ed25519 is deterministic.
    // A signer that only remembered what ITS OWN process had signed would be
    // refused here — which is why a fresh one treats the second it was born in
    // as already spent.
    const one = await hub({}, { slotPeriodSeconds: 3600 });
    const station = await bootStation();
    const payer = evmPayer();

    const first = await one.boot();
    const granted = await configured(first, payer, station);
    await bought(first, payer, station);

    const dropped = `${granted}.now`;
    await withdrawForwardedRoutes(asOperator(one), { grantedPrefix: dropped });

    // Down and back up with no pause at all, which is the case that breaks:
    // the rewrite lands inside the same second as the write it repeats.
    await first.stop();
    await one.boot();

    expect(one.operator.refusals()).toEqual([]);
    expect(one.operator.routes().map((route) => route.prefix)).toContain(
      dropped
    );
  });
});

// ---------- What the roster does not hold is taken back out ----------

describe('a peering or a route the connector holds that the roster does not', () => {
  it('is removed at boot, including the peering a crashed purchase left behind', async () => {
    const one = await hub({}, { slotPeriodSeconds: 3600 });
    const station = await bootStation();
    const payer = evmPayer();

    const first = await one.boot();
    await configured(first, payer, station);

    // A purchase whose peering landed and whose routes would not write. The
    // roster is written LAST, so what this leaves behind is exactly what a
    // crash between the two writes leaves behind: a peering the hub is
    // funding and no slot anywhere that says why.
    one.operator.failNextWrites(99, '/routes/peers');
    const refused = await fetch(appUrl(first, '/buy'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-toon-payer': payer,
        'x-toon-amount': '1000000',
        'x-toon-chain': 'evm',
      },
      body: JSON.stringify({ stationUrl: station.url }),
    });
    expect(refused.status).toBe(503);
    one.operator.failNextWrites(0);

    expect(one.operator.peerings()).toHaveLength(1);
    expect((await roster(first)).slots).toEqual([]);

    await first.stop();
    const second = await one.boot();

    // The collateral comes back, because the peering does.
    expect(one.operator.peerings()).toEqual([]);
    expect(one.operator.routes()).toEqual([]);
    expect((await roster(second)).slots).toEqual([]);
  });

  it('is removed at boot when it is a route beneath an address nobody holds', async () => {
    const one = await hub();
    const orphan = 'abcdef012345';

    // A peering and a route written by hand under a label that looks exactly
    // like one this hub grants — but that no slot on its roster holds.
    const station = await bootStation();
    station.terminateAt(`${HUB_ADDRESS}.${orphan}`);
    await establishPeering(asOperator(one), {
      localLabel: orphan,
      stationUrl: station.url,
      chain: 'evm',
    });
    await writeForwardedRoutes(asOperator(one), {
      localLabel: orphan,
      routes: [
        {
          prefix: `${HUB_ADDRESS}.${orphan}.now`,
          stationPrice: 50n,
          price: 60n,
          pricePerKib: 0n,
        },
      ],
    });
    expect(one.operator.routes()).toHaveLength(1);

    await one.boot();

    expect(one.operator.routes()).toEqual([]);
    expect(one.operator.peerings()).toEqual([]);
  });
});

// ---------- The fence: what a boot must never touch ----------

describe('the boot removes only rows this app could have written', () => {
  it("never touches a row the hub operator's own config file owns, even one shaped like a handle", async () => {
    // The row is `source: "config"`, sits BENEATH the hub's own address, and
    // its label is a well-formed twelve-hex handle. Every fence but the source
    // one says "yours". The connector would answer 409 — and this asserts the
    // app never asks, because a fence that consists of being refused is not a
    // fence.
    const reserved = 'aaaaaaaaaaaa';
    const one = await hub({
      configuredPeerings: [{ id: reserved }],
      configuredRoutes: [
        {
          prefix: `${HUB_ADDRESS}.${reserved}.now`,
          peer_id: reserved,
          price: 500,
        },
      ],
    });

    await one.boot();

    // Nothing was sent at all: no removal, and no write of any kind.
    expect(writeLog(one.operator)).toEqual([]);
    expect(one.operator.refusals()).toEqual([]);
  });

  it("never touches the hub operator's own hand-written runtime rows", async () => {
    // A peering an operator wrote themselves, under a label no derivation
    // produces, carrying an address outside the space this hub grants. It is
    // on no roster — and it is none of this app's business.
    const one = await hub();
    const station = await bootStation();
    station.terminateAt('g.other.apex');
    await establishPeering(asOperator(one), {
      localLabel: 'apex-relay-2',
      stationUrl: station.url,
      chain: 'evm',
    });
    await writeForwardedRoutes(asOperator(one), {
      localLabel: 'apex-relay-2',
      routes: [
        {
          prefix: 'g.other.apex',
          stationPrice: 100n,
          price: 110n,
          pricePerKib: 0n,
        },
      ],
    });
    const before = writeLog(one.operator).length;

    await one.boot();

    expect(writeLog(one.operator).slice(before)).toEqual([]);
    expect(one.operator.peerings().map((peering) => peering.id)).toEqual([
      'apex-relay-2',
    ]);
    expect(carrying(one.operator)).toEqual(['g.other.apex -> apex-relay-2']);
  });

  it('leaves another broadcaster alone while it tears down the one that lapsed', async () => {
    // Two broadcasters on one hub, and only one of them still paid up when
    // the hub comes back. A hub's routing table is shared by everybody it
    // admitted, and a runtime row carries no owner for the connector to check.
    const one = await hub({}, { slotPeriodSeconds: 2 });
    const staying = await bootStation();
    const leaving = await bootStation();
    const stayingPayer = evmPayer();
    const leavingPayer = evmPayer();

    const first = await one.boot();
    const stayingPrefix = await configured(first, stayingPayer, staying);
    const leavingPrefix = await configured(first, leavingPayer, leaving);
    const leavingSlot = await bought(first, leavingPayer, leaving);
    await first.stop();

    // The one who is coming back renews from a hub booted with a long period
    // while the other's slot runs out.
    const second = await one.boot({ slotPeriodSeconds: 3600 });
    const stayingSlot = await bought(second, stayingPayer, staying);
    await until(
      'the other broadcaster to have lapsed',
      () => Date.now() > leavingSlot.lapsesAt
    );
    await second.stop();

    const before = writeLog(one.operator).length;
    const third = await one.boot({ slotPeriodSeconds: 3600 });

    expect(one.operator.peerings().map((peering) => peering.id)).toEqual([
      stayingSlot.label,
    ]);
    expect(carrying(one.operator)).toEqual(
      LADDER.map(
        (rung) => `${stayingPrefix}.${rung.rung} -> ${stayingSlot.label}`
      ).sort()
    );
    expect((await roster(third)).slots.map((slot) => slot.payer)).toEqual([
      stayingPayer,
    ]);

    // And every address the boot removed was beneath the lapsed grant —
    // asserted by naming them, not by counting them.
    for (const entry of writeLog(one.operator)
      .slice(before)
      .filter((line) => line.startsWith('DELETE /routes/peers/'))) {
      const prefix = decodeURIComponent(
        entry.slice('DELETE /routes/peers/'.length)
      );
      expect({
        prefix,
        beneath: prefix.startsWith(`${leavingPrefix}.`),
      }).toEqual({ prefix, beneath: true });
    }
  });
});

// ---------- The roster address ----------

describe('GET /roster', () => {
  it('answers who holds a slot and when each lapses, reading no payment header', async () => {
    const one = await hub({}, { slotPeriodSeconds: 3600, slotCap: 7 });
    const station = await bootStation();
    const payer = evmPayer();
    const app = await one.boot();

    // Nothing about the request says anything about payment: no payer, no
    // amount, no chain. There is no connector in front of this address to
    // state one, which is exactly why it must never acquire a route.
    const empty = await fetch(appUrl(app, '/roster'));
    expect(empty.status).toBe(200);
    expect(empty.headers.get('content-type')).toContain('application/json');
    expect(await empty.json()).toEqual({
      hubAddress: HUB_ADDRESS,
      slotCap: 7,
      slotsHeld: 0,
      slots: [],
      timestamp: expect.any(Number),
    });

    const granted = await configured(app, payer, station);
    const slot = await bought(app, payer, station);

    expect(await roster(app)).toEqual({
      hubAddress: HUB_ADDRESS,
      slotCap: 7,
      slotsHeld: 1,
      slots: [
        {
          payer,
          label: slot.label,
          prefix: granted,
          lapsesAt: slot.lapsesAt,
        },
      ],
      timestamp: expect.any(Number),
    });
  });

  it('survives a restart, because the roster does', async () => {
    const one = await hub({}, { slotPeriodSeconds: 3600 });
    const station = await bootStation();
    const payer = evmPayer();

    const first = await one.boot();
    const granted = await configured(first, payer, station);
    const slot = await bought(first, payer, station);
    await first.stop();

    const second = await one.boot();
    expect((await roster(second)).slots).toEqual([
      { payer, label: slot.label, prefix: granted, lapsesAt: slot.lapsesAt },
    ]);
  });

  it('lists the slot that lapses soonest first', async () => {
    const one = await hub({}, { slotPeriodSeconds: 3600 });
    const sooner = await bootStation();
    const later = await bootStation();
    const soonerPayer = evmPayer();
    const laterPayer = evmPayer();

    const app = await one.boot();
    await configured(app, soonerPayer, sooner);
    await configured(app, laterPayer, later);
    const first = await bought(app, soonerPayer, sooner);
    const second = await bought(app, laterPayer, later);

    // Bought in that order, so their lapses are in that order too — the point
    // is that the answer is ordered by the number an operator came to read.
    expect(second.lapsesAt).toBeGreaterThanOrEqual(first.lapsesAt);
    expect((await roster(app)).slots.map((slot) => slot.label)).toEqual([
      first.label,
      second.label,
    ]);
  });
});
