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
 * What exists today (issues #33 and #34) is the boot and the quote:
 *
 *   - `GET /health` on the app port: process liveness, for a hub operator's
 *     supervisor inside the node. It requires no payment header, reads none,
 *     and echoes none. It sits outside every prefix the hub's connector routes
 *     and **must never acquire a route** — the app port is published on no
 *     interface, which is what makes "unpriced" mean "in-node" rather than
 *     "free to the internet".
 *
 *   - `GET /quote` on the app port: **paid**, at a floor price, beneath its
 *     own connector prefix and never the buy's. It answers the prefix this
 *     hub would grant the caller, what a slot costs, how long it lasts, and
 *     whether there is capacity under the operator's cap — see
 *     `../quote/quote.ts` for why every foreseeable refusal is moved here.
 *
 *   - the two operator credentials, resolved from their mounted files before
 *     anything binds. Both are named by path only and the app refuses to start
 *     without either, saying which one — see `../operator/credentials.ts`.
 *
 *   - the hub's admission policy — price, period, cap and the hub's own
 *     address — resolved and checked before anything binds, and reported back
 *     on the resolved configuration. See `../slot/policy.ts`.
 *
 * The buy that establishes the peering, the roster's writer, the lapse and the
 * boot reconciliation are #35 onward and are deliberately not here yet.
 * Nothing in this file anticipates them beyond leaving the shape they hang
 * off: the roster this app reads has no write path, because nothing here
 * needs one.
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
import { resolveOperatorCredentials } from '../operator/credentials.js';
import { QUOTE_ROUTE_PREFIX, quoteRoutes } from '../quote/quote.js';
import { describeSlotPolicy, resolveSlotPolicy } from '../slot/policy.js';
import type { SlotPolicy } from '../slot/policy.js';
import { createSlotRoster } from '../slot/roster.js';
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
 * Where the quote answers. **Paid**, beneath its own connector prefix and
 * never the buy's, so neither address is ever reachable at the other's price.
 * Re-exported here so a hub operator writing `connector.toml` reads the app's
 * whole surface off one module.
 */
export { QUOTE_ROUTE_PREFIX } from '../quote/quote.js';

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
 * broadcaster's quote, and neither is this.
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
 *
 * @example
 * ```ts
 * const app = await startSlotApp({
 *   slotPort: 0,
 *   dataDir: '/tmp/hub',
 *   hubAddress: 'g.toon.slopmachine',
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
  // Only the two PATHS are kept. Nothing signs a write or makes a read yet
  // (#34 onward), and a secret held by a process that cannot use it is a
  // secret for nothing — so the values are read, checked, and dropped on the
  // next line. What this call is here for is the refusal, and the refusal is
  // the same one it will be when the writes exist.
  const { writeKeyFile, bearerTokenFile } = resolveOperatorCredentials(config);

  // The hub's admission policy, on the same terms: checked before anything
  // binds, because a hub quoting a price nobody set is worse than a hub that
  // did not come up.
  const policy = resolveSlotPolicy(config);

  // Fail at boot rather than at the first write: a directory the app cannot
  // create is a refuse-to-start, never a degraded run.
  mkdirSync(dataDir, { recursive: true });

  // The roster the quote reads. Nothing writes a slot yet — the buy is #35 —
  // so a hub booted from here holds none, and every caller's quote says so.
  // What replaces this line is a read-back off the data directory, not a
  // different shape of reader.
  const roster = createSlotRoster();

  const app = new Hono();

  // Liveness. No middleware runs before it, nothing reads a request header,
  // and the response carries only what a supervisor needs. It sits outside
  // every prefix the hub's connector routes, which is what keeps it unpriced
  // and reachable from inside the node only.
  app.get(HEALTH_ROUTE_PATH, (c) => c.json(livenessResponse()));

  // The quote, mounted at its own prefix and beneath nothing. The connector in
  // front terminates one route on exactly this path at its own floor price;
  // the buy will get another, at the slot price, and the two must never be the
  // same prefix.
  app.route(QUOTE_ROUTE_PREFIX, quoteRoutes({ policy, roster }));

  const { server, port } = await listen(app.fetch, host, requestedPort);

  const resolvedConfig: ResolvedSlotAppConfig = {
    slotPort: port,
    host,
    dataDir,
    policy,
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

  let running = true;

  return {
    isRunning() {
      return running;
    },
    async stop() {
      if (!running) return;
      running = false;
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
