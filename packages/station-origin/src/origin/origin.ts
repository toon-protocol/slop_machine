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
 * What exists today (issues #5 and #6) is the boot path, one address, and the
 * door a broadcaster's vibes come in through:
 *
 *   - `GET /health` on the segment port: liveness, for a supervisor inside the
 *     node. It requires no payment header, reads none, and echoes none. It is
 *     deliberately outside every prefix the connector routes, so it is
 *     reachable from inside the node and from nowhere else — the segment port
 *     is never published to a host interface.
 *
 *   - RTMP/RTMPS ingest on the ingest port: a broadcaster publishes with their
 *     stream key and goes live. Unlike the segment port, this one *is*
 *     published by the station node — stock Caddy does not speak RTMP — so it
 *     is the origin's own listener that terminates TLS and checks the key.
 *     Ingest is authenticated and never paid.
 *
 * The rung ladder, segments, retention and the station's *now* are issues
 * #7-#14 and are not here yet.
 *
 * The two ports and the data directory are configuration rather than
 * constants: the integration suite boots real instances on fresh ports against
 * temporary directories, and a broadcaster-operator moves any of them without a
 * code change. The stream key is configuration too, but of a different kind —
 * it is provisioned as a mounted value and the origin refuses to start without
 * one.
 *
 * @module
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import {
  startIngest,
  DEFAULT_INGEST_PORT,
  DEFAULT_INGEST_HOST,
  type IngestInstance,
  type IngestSession,
  type IngestTlsConfig,
} from '../ingest/ingest.js';
import { resolveStreamKey } from '../ingest/stream-key.js';
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

export { DEFAULT_INGEST_PORT, DEFAULT_INGEST_HOST };

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

  /**
   * The station's stream key. Exactly one of this and `streamKeyFile` is
   * required — an origin with no stream key refuses to start, because a
   * station anyone can broadcast on looks exactly like a working one.
   */
  streamKey?: string | undefined;
  /**
   * Path to a mounted file holding the stream key. This is how a deployed
   * station is provisioned: the key is never baked into an image and never
   * committed.
   */
  streamKeyFile?: string | undefined;

  /**
   * Port the origin accepts a broadcaster's publish on (default: 1935).
   *
   * Unlike the segment port, this one is published by the station node itself:
   * stock Caddy does not speak RTMP, so the origin fronts its own ingest. `0`
   * binds an ephemeral port.
   */
  ingestPort?: number;
  /** Bind host for the ingest port (default: 0.0.0.0). */
  ingestHost?: string;
  /**
   * Mounted certificate and key for the ingest listener. Supplied, ingest is
   * RTMPS; omitted, it is plain RTMP and says so loudly at boot.
   */
  ingestTls?: IngestTlsConfig | undefined;

  /**
   * Called once per accepted publish, with the broadcaster's vibes attached as
   * an FLV stream. This is the seam the segmenter (issue #7) attaches to.
   * Omitted, accepted vibes are counted and discarded.
   */
  onIngest?: ((session: IngestSession) => void) | undefined;
}

/** An `OriginConfig` with every default applied and the bound port resolved. */
export interface ResolvedOriginConfig {
  /** The port actually bound — never `0`, even when `0` was configured. */
  segmentPort: number;
  host: string;
  /** Absolute path to the data directory. */
  dataDir: string;
  /** The ingest port actually bound — never `0`, even when `0` was configured. */
  ingestPort: number;
  /** The host the ingest port is bound to. */
  ingestHost: string;
  /**
   * Whether ingest terminates TLS, i.e. whether it is RTMPS.
   *
   * The stream key is deliberately absent from this record. It is the one
   * secret the origin holds; it is never reported back, logged, or echoed.
   */
  ingestTls: boolean;
}

/** A running station origin returned by `startOrigin()`. */
export interface OriginInstance {
  /** Whether the origin is currently running. */
  isRunning(): boolean;
  /**
   * Whether a broadcaster is publishing right now.
   *
   * This is not liveness and it is not the station's *now* — it is the plain
   * fact of an accepted publish being open, which is what a supervisor and
   * (from issue #12) the *now* address are both built on.
   */
  isIngesting(): boolean;
  /** Stop the origin and release both listeners. Idempotent. */
  stop(): Promise<void>;
  /** The resolved configuration, including the ports actually bound. */
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
 * Resolves configuration, creates the data directory, and binds both the
 * ingest port and the segment port. Resolves once both listeners are
 * accepting connections, so a caller that awaits it can dial the origin — or
 * publish to it — on the next line.
 *
 * Fails closed. A missing stream key, an unreadable certificate or a port that
 * will not bind is a refusal to start, never a degraded run: a station that
 * came up without its key would accept anybody's vibes while looking healthy.
 *
 * @param config - Origin configuration. Every field has a default except the
 * stream key, of which exactly one of `streamKey` and `streamKeyFile` is
 * required.
 * @returns A running `OriginInstance`.
 * @throws StreamKeyError if no stream key is configured, or both are.
 * @throws IngestTlsError if a configured certificate or key cannot be read.
 *
 * @example
 * ```ts
 * const origin = await startOrigin({
 *   segmentPort: 0,
 *   ingestPort: 0,
 *   dataDir: '/tmp/station',
 *   streamKeyFile: '/run/secrets/station.key',
 * });
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

  // The key first, before anything binds. A station that cannot be
  // authenticated should never have reached the point of holding a port open.
  const streamKey = resolveStreamKey(config);

  // Fail at boot rather than at the first segment: a directory the origin
  // cannot create is a refuse-to-start, never a degraded run.
  mkdirSync(dataDir, { recursive: true });

  const ingest = await startIngest({
    streamKey,
    port: config.ingestPort ?? DEFAULT_INGEST_PORT,
    host: config.ingestHost ?? DEFAULT_INGEST_HOST,
    tls: config.ingestTls,
    onPublish: config.onIngest,
  });

  const app = new Hono();

  // Liveness. No middleware runs before it, nothing reads a request header,
  // and the response carries only what a supervisor needs.
  app.get('/health', (c) => c.json(livenessResponse()));

  let server: ServerType;
  let port: number;
  try {
    ({ server, port } = await listen(app.fetch, host, requestedPort));
  } catch (error) {
    // Half a station is not a station: an origin that ingests but cannot serve
    // would take a broadcaster live to nobody.
    await ingest.stop();
    throw error;
  }

  const resolvedConfig: ResolvedOriginConfig = {
    segmentPort: port,
    host,
    dataDir,
    ingestPort: ingest.port,
    ingestHost: ingest.host,
    ingestTls: ingest.tls,
  };

  console.log(
    `[station-origin] v${VERSION} serving on http://${host}:${port} (data dir: ${dataDir})`
  );

  let running = true;

  return {
    isRunning() {
      return running;
    },
    isIngesting() {
      return running && ingest.isLive();
    },
    async stop() {
      if (!running) return;
      running = false;
      await stopBoth(server, ingest);
    },
    config: resolvedConfig,
  };
}

/**
 * Stop both listeners, and report the first failure only after both have been
 * asked to stop — a segment port that will not close must not leave the ingest
 * port open behind it.
 */
async function stopBoth(
  server: ServerType,
  ingest: IngestInstance
): Promise<void> {
  const results = await Promise.allSettled([
    new Promise<void>((resolveStop, rejectStop) => {
      server.close((err) => (err ? rejectStop(err) : resolveStop()));
    }),
    ingest.stop(),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
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
