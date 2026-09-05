/**
 * startSlotApp() — the slot app, as a running app.
 *
 * The slot app is the hub's admission desk. A broadcaster buys a **slot** from
 * it, and the hub's operator key creates the **peering** and writes the routes
 * that make that broadcaster's station reachable. Slot and peering are two
 * words for two things and this app never spells one of them with the other's
 * name (ADR 0003).
 *
 * Like the station origin it sits behind the connector, and like the origin it
 * contains **no payment code**: no claim validation, no settlement key, no
 * payment-header parsing, no pricing logic. By the time a request reaches this
 * process the connector in front of it has already proven it paid. Pricing a
 * route is connector configuration. That split is the repo's invariant and
 * this app — the one that reaches back into a connector's operator surface —
 * does not become the exception to it.
 *
 * What exists today (issues #33 through #39) is the boot, the quote, the buy,
 * the renewal, the lapse, the reconciliation and the operator's two unpriced
 * addresses:
 *
 *   - `GET /health` on the app port: process liveness, for a hub operator's
 *     supervisor inside the node. It requires no payment header, reads none,
 *     and echoes none. It sits outside every prefix the hub's connector routes
 *     and **must never acquire a route** — the app port is published on no
 *     interface, which is what makes "unpriced" mean "in-node" rather than
 *     "free to the internet".
 *
 *   - `GET /roster` on the app port: **unpriced on exactly the same terms**,
 *     and on the same terms it must never acquire a connector route. It
 *     answers who holds a slot and when each lapses, so a hub operator does
 *     not read their own database by hand. See `../slot/roster-view.ts`.
 *
 *   - `GET /quote` on the app port: **paid**, at a floor price, beneath its
 *     own connector prefix and never the buy's. It answers the prefix this
 *     hub would grant the caller, what a slot costs, how long it lasts, and
 *     whether there is capacity under the operator's cap — see
 *     `../quote/quote.ts` for why every foreseeable refusal is moved here.
 *
 *   - `POST /buy` on the app port: **paid**, at the slot price, beneath its
 *     own connector prefix and never the quote's. It reads the station
 *     connector's own self-description, establishes the **peering** toward
 *     that station, writes one forwarded route per address the station sells
 *     — each priced from that station's own published price plus the hub's
 *     carriage — takes back out any row beneath that caller's granted prefix
 *     the station has stopped publishing, and records the **slot** durably,
 *     all of it before it answers. The fulfill means you are peered. See
 *     `../buy/buy.ts`, `../peering/station-description.ts` and
 *     `../peering/routes.ts`.
 *
 *   - **buying again at that same address is renewing** (#37). One call, not
 *     two: the same handle, the same granted prefix, one slot on the roster,
 *     the established peering found rather than a second channel opened, and
 *     the lapse extended by a period from whichever is later — the lapse
 *     already held, or now.
 *
 *   - the two operator credentials, resolved from their mounted files before
 *     anything binds. Both are named by path only and the app refuses to start
 *     without either, saying which one — see `../operator/credentials.ts`.
 *     The write key is **decoded** at boot too, by the code that signs with
 *     it, so a key a hub cannot sign with is a refusal to start rather than a
 *     `401` on the first broadcaster's purchase.
 *
 *   - the hub's admission policy — price, period, cap and the hub's own
 *     address — resolved and checked before anything binds, and reported back
 *     on the resolved configuration. See `../slot/policy.ts`.
 *
 *   - the hub's **peering** policy — where its operator surface is, what it
 *     charges to carry a packet to a broadcaster, and how large a packet it
 *     will carry. The operator surface is **configuration**, never an
 *     injected port: the suite points it at a fake and the app's own API is
 *     the same either way. See `../peering/policy.ts`.
 *
 *   - the roster, opened in the data directory and **read back at boot**, so a
 *     restarted hub still knows who it admitted and when each slot lapses.
 *
 *   - **the lapse ticker** (#38), walking the roster on a configured interval
 *     and tearing down everything past its lapse time on the hub's own
 *     initiative, with no request needed to trigger it: every route out
 *     first, then the peering released — which is what brings the collateral
 *     behind a dead station back — and only then the slot off the roster. See
 *     `../lapse/lapse.ts` for why that order is the connector's rule rather
 *     than a preference, and why the roster row goes last.
 *
 *   - **boot reconciliation** (#39), run before the port binds. It reads the
 *     connector's own peerings and routes over the bearer-gated read surface
 *     and makes them agree with the roster: what a crash left unwritten is
 *     written, what the roster does not hold is taken back out, and anything
 *     that lapsed while the process was down is torn down at once rather than
 *     surviving the downtime. That last is why the ticker's first sweep is one
 *     interval after boot and not at it — see `../reconcile/reconcile.ts`,
 *     which also holds the three fences that keep a removal off a row this app
 *     does not own.
 *
 * The app port, the data directory and every number in the hub's admission
 * policy are configuration rather than constants: the suite boots real
 * instances on fresh ports against temporary directories, and a hub operator
 * changes their admission policy without a code change.
 *
 * @module
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { BUY_ROUTE_PREFIX, buyRoutes } from '../buy/buy.js';
import {
  describeLapseSweep,
  resolveLapseSweepSeconds,
  startLapseTicker,
} from '../lapse/lapse.js';
import { resolveOperatorCredentials } from '../operator/credentials.js';
import { createWriteSigner } from '../operator/write-signature.js';
import {
  describePeeringPolicy,
  resolvePeeringPolicy,
} from '../peering/policy.js';
import type { PeeringPolicy } from '../peering/policy.js';
import { QUOTE_ROUTE_PREFIX, quoteRoutes } from '../quote/quote.js';
import { reconcileAtBoot } from '../reconcile/reconcile.js';
import { describeSlotPolicy, resolveSlotPolicy } from '../slot/policy.js';
import type { SlotPolicy } from '../slot/policy.js';
import { openSlotRoster } from '../slot/roster.js';
import { ROSTER_ROUTE_PATH, rosterRoutes } from '../slot/roster-view.js';
import { VERSION } from '../version.js';

// ---------- Defaults ----------

/**
 * Default app port (env: `TOON_SLOT_PORT`).
 *
 * A default, never a constant the app depends on. Pass `0` to bind an
 * ephemeral port; the port actually bound is reported back on
 * `SlotAppInstance.config.slotPort`.
 */
export const DEFAULT_SLOT_PORT = 3200;

/** Default bind host for the app port (env: `TOON_SLOT_HOST`). */
export const DEFAULT_HOST = '0.0.0.0';

/** Default data directory — the hub's own state lives here (env: `TOON_DATA_DIR`). */
export const DEFAULT_DATA_DIR = './data';

/**
 * Where liveness answers. Unpriced, and outside every prefix the hub's
 * connector routes — a route to it would put a hub operator's diagnostics on
 * sale and on the internet at the same time.
 */
export const HEALTH_ROUTE_PATH = '/health';

/**
 * Where the roster answers. Unpriced, and outside every prefix the hub's
 * connector routes, on exactly the same terms as liveness: it is the hub
 * operator asking their own process who is admitted, on a port only they can
 * reach, and a route to it would put that answer on sale and on the internet
 * at once.
 */
export { ROSTER_ROUTE_PATH } from '../slot/roster-view.js';

/**
 * Where the quote answers. **Paid**, beneath its own connector prefix and
 * never the buy's, so neither address is ever reachable at the other's price.
 * Re-exported here so a hub operator writing `connector.toml` reads the app's
 * whole surface off one module.
 */
export { QUOTE_ROUTE_PREFIX } from '../quote/quote.js';

/**
 * Where the buy answers. **Paid**, at the slot price, beneath its own
 * connector prefix and never the quote's — one handler, one price.
 */
export { BUY_ROUTE_PREFIX } from '../buy/buy.js';

// ---------- Configuration ----------

/** Configuration for starting a slot app via `startSlotApp()`. */
export interface SlotAppConfig {
  /**
   * Port the app serves on (default: 3200).
   *
   * This port must never be published to a host interface: a hub publishes
   * exactly Caddy's 80 and 443, and the app reaches the compose network only.
   * `0` binds an ephemeral port.
   */
  slotPort?: number;
  /** Bind host for the app port (default: 0.0.0.0). */
  host?: string;
  /**
   * Directory the app owns on disk (default: ./data). Created at boot if it
   * does not exist.
   */
  dataDir?: string;

  /**
   * The hub's own ILP address (default: `g.toon.slopmachine`). Every prefix
   * this hub grants sits directly beneath it.
   */
  hubAddress?: string | undefined;
  /**
   * What a slot costs for one period, in the settlement token's smallest unit
   * (default: `1000000`). Reported by the quote; never charged here.
   */
  slotPrice?: number | string | undefined;
  /**
   * How long one purchase lasts, in seconds (default: 30 days).
   *
   * Seconds, because that is the unit that makes a lapse testable without a
   * fake clock — the suite sets it to a second or two.
   */
  slotPeriodSeconds?: number | string | undefined;
  /**
   * How many slots may be held at once (default: `100`). `0` is a legal
   * policy and means the hub is admitting nobody.
   */
  slotCap?: number | string | undefined;
  /**
   * How often the hub walks its roster looking for lapsed slots, in seconds
   * (default: 60).
   *
   * The granularity of the lapse, not its length. Seconds for the same reason
   * the period is: it is what makes a lapse testable in real time rather than
   * against a fake clock.
   */
  lapseSweepSeconds?: number | string | undefined;

  /**
   * Base URL of the hub connector's **operator surface** — where the peering
   * is written.
   *
   * Required; there is no default. In a hub bundle this is the connector on
   * the compose network, e.g. `http://connector:3000`. **Configuration, not
   * an injected port**: the suite points it at a fake operator surface and
   * the app's own API is the same either way.
   */
  operatorUrl?: string | undefined;
  /**
   * What the hub retains for carrying one packet to a broadcaster it peered
   * with (default: `10`). The hub's own policy — a broadcaster never chooses
   * how far the hub trusts them.
   */
  peeringFee?: number | string | undefined;
  /**
   * The largest amount the hub will forward to a broadcaster in one packet
   * (default: `10000000`). The hub's own policy, on the same terms.
   */
  peeringMaxPacketAmount?: number | string | undefined;

  /**
   * Path to the mounted file holding the hub's operator **write key**.
   *
   * Required — there is no default, and there is deliberately no form of this
   * that takes the key itself. The app refuses to start without it.
   */
  operatorWriteKeyFile?: string | undefined;
  /**
   * Path to the mounted file holding the hub's operator **bearer token**.
   *
   * Required, on exactly the same terms as the write key.
   */
  operatorBearerTokenFile?: string | undefined;
}

/**
 * A `SlotAppConfig` with every default applied and the bound port resolved.
 *
 * **Neither operator credential's value appears here**, or anywhere else a
 * caller can reach. The two file *paths* do: a path is not a secret, and an
 * operator reading back what the app resolved needs to see which mount it
 * took.
 */
export interface ResolvedSlotAppConfig {
  /** The port actually bound — never `0`, even when `0` was configured. */
  slotPort: number;
  host: string;
  /** Absolute path to the data directory. */
  dataDir: string;
  /**
   * The hub's admission policy, resolved and checked — its own address, what a
   * slot costs, how long one lasts, and how many may exist at once. Ordinary
   * configuration, all of it readable back, none of it secret.
   */
  policy: SlotPolicy;
  /**
   * How often the hub walks its roster tearing down lapsed slots, in seconds.
   * Ordinary configuration, readable back like every other number here.
   */
  lapseSweepSeconds: number;
  /**
   * The hub's peering policy — where its operator surface is, what it charges
   * to carry a packet to a broadcaster, and how large a packet it will carry.
   * A URL and two numbers, none of it secret.
   */
  peering: PeeringPolicy;
  /** The path the operator write key was read from. Never its contents. */
  operatorWriteKeyFile: string;
  /** The path the operator bearer token was read from. Never its contents. */
  operatorBearerTokenFile: string;
}

/** A running slot app returned by `startSlotApp()`. */
export interface SlotAppInstance {
  /** Whether the app is currently running. */
  isRunning(): boolean;
  /** Stop the app and release its listener. Idempotent. */
  stop(): Promise<void>;
  /** The resolved configuration, including the port actually bound. */
  config: ResolvedSlotAppConfig;
}

// ---------- Liveness ----------

/**
 * The liveness response.
 *
 * This is *process* liveness — "is the slot app up enough to answer" — and it
 * is what a hub operator's supervisor dials to decide whether to restart. It
 * is not a claim about the roster, about the hub's capacity, or about whether
 * any broadcaster holds a slot; those are the operator's roster address and a
 * broadcaster's quote, and neither is this. A process that answers here has
 * bound its port, which means it has already reconciled.
 */
interface LivenessResponse {
  status: 'healthy';
  service: 'slot-app';
  version: string;
  timestamp: number;
}

function livenessResponse(): LivenessResponse {
  return {
    status: 'healthy',
    service: 'slot-app',
    version: VERSION,
    timestamp: Date.now(),
  };
}

// ---------- Boot ----------

/**
 * Start a slot app.
 *
 * Resolves configuration, reads both operator credentials, creates the data
 * directory, and binds the app port. Resolves once the listener is accepting
 * connections, so a caller that awaits it can dial the app on the next line.
 *
 * Fails closed. A missing or unreadable credential, or a port that will not
 * bind, is a refusal to start rather than a degraded run — a hub that cannot
 * admit anybody must look broken rather than look fine.
 *
 * @param config - Slot app configuration. Every field has a default except the
 * two operator credential paths, both of which are required.
 * @returns A running `SlotAppInstance`.
 * @throws OperatorCredentialError if either credential path is unset, or the
 * file it names is unreadable or empty. The refusal names which credential.
 * @throws SlotPolicyError if the hub's admission policy cannot be read. A hub
 * must not admit broadcasters on a number nobody chose.
 * @throws PeeringPolicyError if no operator surface is configured, or the
 * terms the hub peers on cannot be read.
 * @throws LapseError if the sweep interval is not a whole number of seconds.
 * There is no value that disables the sweep: a hub that never reclaims
 * anything is the bug the ticker exists to close.
 * @throws SlotRosterError if the data directory holds something this app
 * cannot read as a roster. A hub that started from an empty roster would
 * re-admit everybody it already holds.
 *
 * @example
 * ```ts
 * const app = await startSlotApp({
 *   slotPort: 0,
 *   dataDir: '/tmp/hub',
 *   hubAddress: 'g.toon.slopmachine',
 *   operatorUrl: 'http://connector:3000',
 *   operatorWriteKeyFile: '/run/secrets/operator-write.key',
 *   operatorBearerTokenFile: '/run/secrets/operator-bearer.token',
 * });
 * await fetch(`http://127.0.0.1:${app.config.slotPort}/health`);
 * await app.stop();
 * ```
 */
export async function startSlotApp(
  config: SlotAppConfig = {}
): Promise<SlotAppInstance> {
  const host = config.host ?? DEFAULT_HOST;
  const dataDir = resolve(config.dataDir ?? DEFAULT_DATA_DIR);
  const requestedPort = config.slotPort ?? DEFAULT_SLOT_PORT;

  // The credentials first, before anything binds. An app that cannot make an
  // operator write should never have reached the point of holding a port
  // open: it would answer liveness, satisfy every supervisor on the box, and
  // then fail the first broadcaster who paid.
  //
  // Both values are used and neither is kept anywhere a caller can reach. The
  // write key's goes straight into the signer below and is held there as a
  // key object rather than as bytes. The bearer token's goes to the buy,
  // which needs it to ask the hub's own connector what its routing table
  // currently carries before it takes a stale row back out — a READ, which is
  // the only thing that token is ever used for here. Neither value reaches
  // the resolved configuration, a log line or an error message.
  const { writeKey, writeKeyFile, bearerToken, bearerTokenFile } =
    resolveOperatorCredentials(config);

  // Decoding the seed is the signer's job, not the mounter's, so this is
  // where a key that is not a key is refused — at boot, because a hub that
  // cannot sign a write can admit nobody and must look broken rather than
  // look fine.
  const signer = createWriteSigner(writeKey);

  // The hub's admission policy, on the same terms: checked before anything
  // binds, because a hub quoting a price nobody set is worse than a hub that
  // did not come up.
  const policy = resolveSlotPolicy(config);

  // How often the roster is walked for lapsed slots. Checked here with
  // everything else, because a hub whose sweep interval is nonsense is a hub
  // that would either never reclaim its collateral or spend all day asking
  // its own connector about a roster nothing has changed.
  const lapseSweepSeconds = resolveLapseSweepSeconds(config.lapseSweepSeconds);

  // And its peering policy — where the operator surface is, and the terms the
  // hub peers on. The operator URL is required and has no default: an app
  // that cannot reach an operator surface can admit nobody.
  const peering = resolvePeeringPolicy(config);

  // Fail at boot rather than at the first write: a directory the app cannot
  // create is a refuse-to-start, never a degraded run.
  mkdirSync(dataDir, { recursive: true });

  // The roster, read back off the data directory. A hub that restarts still
  // knows who it admitted and when each slot lapses — a reboot must not
  // re-admit broadcasters it is already funding a channel toward, and must
  // not extend anybody's slot by the length of its own downtime.
  const roster = openSlotRoster(dataDir);

  const app = new Hono();

  // Liveness. No middleware runs before it, nothing reads a request header,
  // and the response carries only what a supervisor needs. It sits outside
  // every prefix the hub's connector routes, which is what keeps it unpriced
  // and reachable from inside the node only.
  app.get(HEALTH_ROUTE_PATH, (c) => c.json(livenessResponse()));

  // The roster, on the same unpriced footing as liveness: no payment header
  // is read and none is required, because there is no connector in front of
  // this address to state one. It answers who holds a slot and when each
  // lapses — the question a hub operator would otherwise answer by reading a
  // database by hand.
  app.route(ROSTER_ROUTE_PATH, rosterRoutes({ policy, roster }));

  // The quote, mounted at its own prefix and beneath nothing. The connector in
  // front terminates one route on exactly this path at its own floor price;
  // the buy will get another, at the slot price, and the two must never be the
  // same prefix.
  app.route(QUOTE_ROUTE_PREFIX, quoteRoutes({ policy, roster }));

  // The buy, at its own prefix and beneath nothing. The connector in front
  // terminates one route on exactly this path at the slot price — never the
  // quote's prefix, so a slot is never sold for the cost of a quote.
  app.route(
    BUY_ROUTE_PREFIX,
    buyRoutes({
      slotPolicy: policy,
      roster,
      policy: peering,
      signer,
      bearerToken,
    })
  );

  // The lapse ticker. Started before the port binds, because taking a dead
  // station's routes and peering back out is not a favour the hub does for
  // whoever happens to call next — it is the hub's own initiative, and the
  // process either does it or it does not. The first sweep is one interval
  // from now: tearing down what was already lapsed at boot is a different job
  // with different rules and belongs to the boot reconciliation (#39).
  const ticker = startLapseTicker({
    roster,
    hubAddress: policy.hubAddress,
    sweepSeconds: lapseSweepSeconds,
    policy: peering,
    signer,
    bearerToken,
  });

  // Boot reconciliation (#39), before the port binds and before this hub can
  // take a purchase. The roster and the connector's own tables are two records
  // of one fact, and a crash between two writes — or a hand-edit — leaves them
  // disagreeing; this is where the disagreement stops being permanent. It also
  // tears down anything that lapsed while the process was down, which is what
  // the ticker's first-sweep-one-interval-later deliberately leaves to it:
  // DOWNTIME MUST NOT EXTEND ANYBODY'S SLOT. It never throws — a hub whose own
  // connector is still coming up boots anyway and reconciles next time.
  await reconcileAtBoot({
    roster,
    hubAddress: policy.hubAddress,
    policy: peering,
    signer,
    bearerToken,
    sweep: ticker.sweep,
  });

  const { server, port } = await listen(app.fetch, host, requestedPort);

  const resolvedConfig: ResolvedSlotAppConfig = {
    slotPort: port,
    host,
    dataDir,
    policy,
    lapseSweepSeconds,
    peering,
    // The paths, never the contents. This record is what a caller reads back
    // and what a log line may safely repeat.
    operatorWriteKeyFile: writeKeyFile,
    operatorBearerTokenFile: bearerTokenFile,
  };

  console.log(
    `[slot-app] v${VERSION} serving on http://${host}:${port} (data dir: ${dataDir})`
  );
  console.log(
    `[slot-app] operator credentials mounted at ${resolvedConfig.operatorWriteKeyFile} (write key) and ${resolvedConfig.operatorBearerTokenFile} (bearer token) — neither value is ever logged`
  );
  console.log(`[slot-app] admission policy: ${describeSlotPolicy(policy)}`);
  console.log(`[slot-app] ${describeLapseSweep(lapseSweepSeconds)}`);
  // The keyid is the PUBLIC half of the write key: the value a hub operator
  // has to have on their connector's write_keys allowlist, and the one thing
  // about that credential it is useful to print. The seed never is.
  console.log(
    `[slot-app] peering policy: ${describePeeringPolicy(peering)}, signing as ${signer.keyid}`
  );

  let running = true;

  return {
    isRunning() {
      return running;
    },
    async stop() {
      if (!running) return;
      running = false;
      // The ticker first, so nothing starts a teardown against a hub that is
      // on its way down — and so a suite is never left holding an open
      // handle for a sweep that will never matter.
      ticker.stop();
      await new Promise<void>((resolveStop, rejectStop) => {
        server.close((err) => (err ? rejectStop(err) : resolveStop()));
      });
    },
    config: resolvedConfig,
  };
}

/**
 * Bind the app port, resolving with the server and the port actually bound —
 * which differs from the requested one whenever `0` was asked for.
 */
function listen(
  fetch: Hono['fetch'],
  hostname: string,
  port: number
): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolveListen, rejectListen) => {
    const server = serve({ fetch, hostname, port }, (info) => {
      resolveListen({ server, port: info.port });
    });
    server.once('error', rejectListen);
  });
}
