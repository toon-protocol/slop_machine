/**
 * startOrigin() — the station origin, as a running app.
 *
 * The origin is one broadcaster's node. It ingests their vibes and serves
 * segments of them over plain HTTP on a port nothing but its own connector can
 * dial. It contains **no payment code**: no payment-header parsing, no
 * settlement key, no operator write key. By the time a request reaches this
 * process the connector in front of it has already proven it paid, and the
 * origin simply serves it. That split is the whole design — the same one
 * `relay` uses — and it is what makes an ordinary HTTP app monetizable
 * without knowing ILP exists.
 *
 * What exists today (issue #5) is the boot path and one address:
 *
 *   - `GET /health` on the segment port: liveness, for a supervisor inside the
 *     node. It requires no payment header, reads none, and echoes none. It is
 *     deliberately outside every prefix the connector routes, so it is
 *     reachable from inside the node and from nowhere else — the segment port
 *     is never published to a host interface.
 *
 * Ingest, the rung ladder, segments and the station's *now* are issues #6-#14
 * and are not here yet.
 *
 * The segment port and the data directory are configuration rather than
 * constants: the integration suite boots real instances on fresh ports against
 * temporary directories, and a broadcaster-operator moves either without a
 * code change.
 *
 * @module
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { VERSION } from '../version.js';

// ---------- Defaults ----------

/**
 * Default segment port (env: `TOON_SEGMENT_PORT`).
 *
 * A default, never a constant the app depends on. Pass `0` to bind an
 * ephemeral port; the port actually bound is reported back on
 * `OriginInstance.config.segmentPort`.
 */
export const DEFAULT_SEGMENT_PORT = 3100;

/** Default bind host for the segment port (env: `TOON_SEGMENT_HOST`). */
export const DEFAULT_HOST = '0.0.0.0';

/** Default data directory — where segments will be written (env: `TOON_DATA_DIR`). */
export const DEFAULT_DATA_DIR = './data';

// ---------- Configuration ----------

/** Configuration for starting a station origin via `startOrigin()`. */
export interface OriginConfig {
  /**
   * Port the origin serves segments and liveness on (default: 3100).
   *
   * This port must never be published to a host interface: the only route to
   * a station's vibes is a paid packet through its connector, which reaches
   * the origin over the compose network. `0` binds an ephemeral port.
   */
  segmentPort?: number;
  /** Bind host for the segment port (default: 0.0.0.0). */
  host?: string;
  /**
   * Directory the origin owns on disk (default: ./data). Segments are written
   * beneath it. Created at boot if it does not exist.
   */
  dataDir?: string;
}

/** An `OriginConfig` with every default applied and the bound port resolved. */
export interface ResolvedOriginConfig {
  /** The port actually bound — never `0`, even when `0` was configured. */
  segmentPort: number;
  host: string;
  /** Absolute path to the data directory. */
  dataDir: string;
}

/** A running station origin returned by `startOrigin()`. */
export interface OriginInstance {
  /** Whether the origin is currently running. */
  isRunning(): boolean;
  /** Stop the origin and release its listener. Idempotent. */
  stop(): Promise<void>;
  /** The resolved configuration, including the port actually bound. */
  config: ResolvedOriginConfig;
}

// ---------- Liveness ----------

/**
 * The liveness response.
 *
 * This is *process* liveness — "is the origin up enough to answer" — and it is
 * what a broadcaster-operator's supervisor dials to decide whether to restart.
 * It is not a claim about ingest. Whether a broadcaster is currently supplying
 * vibes is the station's *now* address, which a viber pays for.
 */
interface LivenessResponse {
  status: 'healthy';
  service: 'station-origin';
  version: string;
  timestamp: number;
}

function livenessResponse(): LivenessResponse {
  return {
    status: 'healthy',
    service: 'station-origin',
    version: VERSION,
    timestamp: Date.now(),
  };
}

// ---------- Boot ----------

/**
 * Start a station origin.
 *
 * Resolves configuration, creates the data directory, and binds the segment
 * port. Resolves once the listener is accepting connections, so a caller that
 * awaits it can dial the origin on the next line.
 *
 * @param config - Origin configuration; every field has a default.
 * @returns A running `OriginInstance`.
 *
 * @example
 * ```ts
 * const origin = await startOrigin({ segmentPort: 0, dataDir: '/tmp/station' });
 * await fetch(`http://127.0.0.1:${origin.config.segmentPort}/health`);
 * await origin.stop();
 * ```
 */
export async function startOrigin(
  config: OriginConfig = {}
): Promise<OriginInstance> {
  const host = config.host ?? DEFAULT_HOST;
  const dataDir = resolve(config.dataDir ?? DEFAULT_DATA_DIR);
  const requestedPort = config.segmentPort ?? DEFAULT_SEGMENT_PORT;

  // Fail at boot rather than at the first segment: a directory the origin
  // cannot create is a refuse-to-start, never a degraded run.
  mkdirSync(dataDir, { recursive: true });

  const app = new Hono();

  // Liveness. No middleware runs before it, nothing reads a request header,
  // and the response carries only what a supervisor needs.
  app.get('/health', (c) => c.json(livenessResponse()));

  const { server, port } = await listen(app.fetch, host, requestedPort);

  const resolvedConfig: ResolvedOriginConfig = {
    segmentPort: port,
    host,
    dataDir,
  };

  console.log(
    `[station-origin] v${VERSION} serving on http://${host}:${port} (data dir: ${dataDir})`
  );

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
 * Bind the segment port, resolving with the server and the port actually
 * bound — which differs from the requested one whenever `0` was asked for.
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
