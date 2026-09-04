/**
 * startIngest() — the door a broadcaster's vibes come in through.
 *
 * A broadcaster points OBS, or anything else that speaks RTMP, at this
 * listener and goes live. Two things are true of it and neither is negotiable:
 *
 *   - **It is authenticated.** The stream name a publisher publishes under is
 *     the station's stream key — which is exactly what OBS calls the "Stream
 *     Key" field, so a broadcaster configures this without learning anything
 *     slop_machine-specific. A wrong or absent key is refused on the `publish`
 *     command, before a byte of media is read and long before anything is
 *     transcoded, and the refusal is sent to the publisher as an RTMP error
 *     status so it surfaces in OBS immediately.
 *
 *   - **It is never paid.** Supplying vibes costs a broadcaster nothing per
 *     second. Nothing here parses a payment header, holds a settlement key, or
 *     knows that ILP exists. Payment is the *viber's* side of the station, it
 *     is enforced by the connector, and it never touches this path.
 *
 * The listener is published by the station node itself rather than fronted by
 * Caddy: stock Caddy does not speak RTMP, and a custom Caddy image would break
 * the fleet's stock-TLS-front norm. It therefore terminates its own TLS —
 * RTMPS is RTMP over TLS and nothing above the socket can tell the difference —
 * when a certificate is mounted.
 *
 * Accepted vibes are handed to `onPublish` as an FLV byte stream, which is what
 * `ffmpeg` reads from a pipe. The segmenter is what consumes it.
 *
 * A station has exactly one broadcaster, and this listener enforces that
 * rather than counting. A dropped uplink is usually not a closed socket — the
 * far end vanishes and the connection sits half-open while the broadcaster's
 * software reconnects on a fresh one — so an accepted publish **supersedes**
 * whatever publish was open, dropping it. That is what keeps a reconnect from
 * looking like a second broadcaster, and what keeps the station's *now* honest
 * about whether anybody is actually supplying vibes.
 *
 * Superseding only covers the broadcaster who comes back. The one who dies
 * quietly and never returns is covered by the idle rule of
 * {@link module:ingest/idle}: a publish that stops sending vibes for the
 * configured interval is taken off the air on the listener's own initiative,
 * so a half-open corpse cannot report a station live indefinitely. The clock
 * counts **vibes, not socket activity** — a connection that is open, healthy
 * and sending no media is a stalled edge, and the station says so.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import {
  createServer as createTcpServer,
  type Server,
  type Socket,
} from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { PassThrough, type Readable } from 'node:stream';
import {
  handleRtmpConnection,
  PUBLISH_DENIED_CODE,
  type RtmpMediaSink,
  type RtmpPublishRequest,
} from './rtmp-session.js';
import { streamKeyMatches } from './stream-key.js';
import { assertIngestIdle, DEFAULT_INGEST_IDLE_SECONDS } from './idle.js';

export {
  DEFAULT_INGEST_IDLE_SECONDS,
  IngestIdleError,
  assertIngestIdle,
} from './idle.js';

/**
 * Default RTMP/RTMPS ingest port (env: `TOON_INGEST_PORT`).
 *
 * 1935 is RTMP's registered port, which is what OBS fills in for a broadcaster
 * who types a bare hostname. Pass `0` to bind an ephemeral port; the port
 * actually bound is reported on `IngestInstance.port`.
 */
export const DEFAULT_INGEST_PORT = 1935;

/** Default bind host for the ingest port (env: `TOON_INGEST_HOST`). */
export const DEFAULT_INGEST_HOST = '0.0.0.0';

/** A certificate and key that turn the ingest listener into an RTMPS one. */
export interface IngestTlsConfig {
  /** Path to the certificate chain, in PEM. */
  certFile: string;
  /** Path to the private key, in PEM. Mounted, never committed. */
  keyFile: string;
}

/** A publish that passed the stream-key gate. */
export interface IngestSession {
  /** The app the broadcaster connected to — `live` in `rtmps://host/live/<key>`. */
  app: string;
  /** The broadcaster's address, for logs. */
  remoteAddress: string | undefined;
  /** When the publish was accepted, in epoch milliseconds. */
  startedAt: number;
  /**
   * The incoming vibes as FLV: a header, then one tag per audio, video or
   * metadata message. This is the seam the segmenter attaches to — pipe it
   * into `ffmpeg -i pipe:0`. It ends when the broadcaster disconnects.
   */
  vibes: Readable;
}

/** Configuration for `startIngest()`. */
export interface IngestConfig {
  /** The station's stream key, already resolved. Required; there is no default. */
  streamKey: string;
  /** Port to listen on (default: 1935). `0` binds an ephemeral port. */
  port?: number;
  /** Bind host (default: 0.0.0.0). */
  host?: string;
  /** Mounted certificate and key. Supplied ⇒ RTMPS; omitted ⇒ plain RTMP. */
  tls?: IngestTlsConfig | undefined;
  /**
   * How long an accepted publish may go without sending vibes before it is
   * taken off the air (default: 30 seconds).
   *
   * The rule, and why it counts media rather than sockets, is
   * {@link module:ingest/idle}. A value that is not a whole number of seconds,
   * or that would switch the rule off, is an `IngestIdleError` at start.
   */
  idleSeconds?: number;
  /**
   * Called once per accepted publish, with the vibes attached. Omit it and
   * accepted media is counted and discarded rather than buffered.
   *
   * Called again on a reconnect, with the new publish's vibes: the publish it
   * supersedes has already had its own vibes ended, so a consumer sees one
   * stream end and another begin rather than two at once.
   */
  onPublish?: ((session: IngestSession) => void) | undefined;
}

/** A running ingest listener. */
export interface IngestInstance {
  /** The port actually bound — never `0`, even when `0` was configured. */
  port: number;
  /** The host it is bound to. */
  host: string;
  /** Whether the listener terminates TLS, i.e. whether it is RTMPS. */
  tls: boolean;
  /** How long a publish may go without vibes before it is taken off the air. */
  idleSeconds: number;
  /**
   * Whether a broadcaster is publishing right now.
   *
   * One publish is on the air at a time: a reconnect takes the air from the
   * connection that held it, and a publish that stops sending vibes for
   * `idleSeconds` is taken off it. So this does not stay true because a dead
   * socket has not noticed yet, whether or not the broadcaster ever returns.
   */
  isLive(): boolean;
  /** Stop listening and drop any publisher. Idempotent. */
  stop(): Promise<void>;
}

/** A TLS configuration that could not be loaded. */
export class IngestTlsError extends Error {
  override readonly name = 'IngestTlsError';
}

/**
 * Start listening for a broadcaster's vibes.
 *
 * Resolves once the listener is accepting connections, so a caller that awaits
 * it can point a publisher at `instance.port` on the next line.
 *
 * @throws IngestIdleError if the idle interval is not a whole number of
 * seconds, or would switch the idle rule off.
 *
 * @example
 * ```ts
 * const ingest = await startIngest({ streamKey: 'k', port: 0, host: '127.0.0.1' });
 * // ffmpeg ... -f flv rtmp://127.0.0.1:${ingest.port}/live/k
 * await ingest.stop();
 * ```
 */
export async function startIngest(
  config: IngestConfig
): Promise<IngestInstance> {
  const host = config.host ?? DEFAULT_INGEST_HOST;
  const requestedPort = config.port ?? DEFAULT_INGEST_PORT;
  const { streamKey, onPublish } = config;

  // Before the port binds, like every other refusal here: an idle rule that
  // cannot be run is the bug it exists to prevent, wearing a config value.
  const idleSeconds = config.idleSeconds ?? DEFAULT_INGEST_IDLE_SECONDS;
  assertIngestIdle(idleSeconds);
  const idleMs = idleSeconds * 1000;

  const sockets = new Set<Socket>();

  /**
   * The one publish that is on the air, if any.
   *
   * A station has one broadcaster, so this is a single slot rather than a
   * count. A count is what a flaky uplink breaks: a dropped connection is
   * frequently *not* a closed one — the far end vanishes and the socket sits
   * half-open until TCP eventually gives up, which can be minutes or, behind a
   * NAT that has forgotten the flow, never. The broadcaster's software mean-
   * while reconnects on a fresh socket within seconds. Counting publishes
   * would then have the station reporting ingest live for as long as the
   * corpse of the old connection lasts, which is exactly the lie this address
   * exists to prevent.
   *
   * A slot is emptied three ways: the publish ends, a new publish supersedes
   * it, or it stops sending vibes for `idleSeconds` and the idle rule takes
   * the air from it. The third is the one that covers a broadcaster who never
   * comes back at all, and it is why the slot carries a clock.
   */
  let onAir: OpenPublish | undefined;

  const onConnection = (socket: Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // Media is latency-sensitive and the messages are small; Nagle would sit
    // on a refusal as readily as on a keyframe.
    socket.setNoDelay(true);
    attach(socket);
  };

  const server = config.tls
    ? createTlsServer(loadTls(config.tls), onConnection)
    : createTcpServer(onConnection);

  await listen(server, host, requestedPort);
  const port = boundPort(server);

  console.log(
    `[station-origin] ingest listening for ${config.tls ? 'RTMPS' : 'RTMP'} on ${host}:${String(port)}, taking a publish off the air after ${String(idleSeconds)}s without vibes`
  );
  if (!config.tls) {
    console.warn(
      '[station-origin] ingest has no certificate mounted, so it speaks plain RTMP; a station reachable from the internet must mount one (TOON_INGEST_TLS_CERT/TOON_INGEST_TLS_KEY)'
    );
  }

  let running = true;

  return {
    port,
    host,
    tls: config.tls !== undefined,
    idleSeconds,
    isLive() {
      return onAir !== undefined;
    },
    async stop() {
      if (!running) return;
      running = false;
      clearAir();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolveStop, rejectStop) => {
        server.close((err) => (err ? rejectStop(err) : resolveStop()));
      });
    },
  };

  function attach(socket: Socket): void {
    /** This connection's publish, while it is the one on the air. */
    let mine: OpenPublish | undefined;

    handleRtmpConnection(socket, {
      onPublish(request) {
        if (!isAuthorized(request)) {
          // The reason is logged; the key the publisher offered is not. A
          // near-miss in a log file is still key material.
          console.warn(
            `[station-origin] ingest refused a publish from ${request.remoteAddress ?? 'an unknown address'}: ${
              request.streamName === '' ? 'no stream key' : 'wrong stream key'
            }`
          );
          return {
            accepted: false,
            code: PUBLISH_DENIED_CODE,
            description:
              request.streamName === ''
                ? 'No stream key was supplied.'
                : 'The stream key is not valid for this station.',
          };
        }

        // The reconnect *is* the drop, seen from this end: a broadcaster whose
        // uplink died comes back on a new socket, and the origin often has no
        // way to know the old one is dead. So an accepted publish takes the
        // air from whatever held it, and the station stays what it is — one
        // broadcaster, one now, one sequence.
        supersede(request.remoteAddress);

        console.log(
          `[station-origin] ingest accepted a publish on app "${request.app}" from ${request.remoteAddress ?? 'an unknown address'}`
        );

        if (onPublish === undefined) {
          mine = takeAir(socket, request.remoteAddress);
          return { accepted: true };
        }

        const { sink, vibes } = flvStream(socket);
        mine = takeAir(socket, request.remoteAddress);
        onPublish({
          app: request.app,
          remoteAddress: request.remoteAddress,
          startedAt: Date.now(),
          vibes,
        });
        return { accepted: true, media: sink };
      },
      onVibes() {
        // The clock is reset by media and by nothing else, so a publisher that
        // keeps the connection warm without sending anything is still a
        // stalled edge. Only the publish holding the air has a clock worth
        // resetting; a superseded one is already gone.
        if (mine !== undefined && onAir === mine) mine.lastVibesAt = Date.now();
      },
      onPublishEnd(request, bytes) {
        // Only if this connection is still the one on the air. A publish that
        // was superseded lost the air the moment the new one was accepted, and
        // its socket finally noticing is not the station going quiet.
        if (mine !== undefined && onAir === mine) clearAir();
        else if (mine !== undefined) disarm(mine);
        mine = undefined;
        console.log(
          `[station-origin] ingest ended for ${request.remoteAddress ?? 'an unknown address'} after ${String(bytes)} bytes of vibes`
        );
      },
      onError(error) {
        console.warn(
          `[station-origin] ingest connection error: ${error.message}`
        );
      },
    });
  }

  /**
   * Take the air from the publish that holds it, for the one about to.
   *
   * The old connection is dropped outright rather than left to expire. Its
   * session ends the way any other ended publish does — the vibes it was
   * feeding are closed, `onPublishEnd` fires — but by then it is no longer the
   * publish on the air, so it cannot take the station off it.
   */
  function supersede(by: string | undefined): void {
    const previous = onAir;
    if (previous === undefined) return;
    clearAir();
    console.log(
      `[station-origin] ingest is taking the air from the publish already open for the reconnect from ${by ?? 'an unknown address'}`
    );
    previous.socket.destroy();
  }

  /**
   * Put a freshly accepted publish on the air, with its idle clock running
   * from now.
   *
   * The clock starts at acceptance rather than at the first media message, so
   * a publisher that completes the handshake, is accepted, and then sends
   * nothing at all is taken off the air on the same schedule as one that
   * stopped mid-broadcast. Both are a station reporting vibes it is not
   * receiving.
   */
  function takeAir(socket: Socket, from: string | undefined): OpenPublish {
    const publish: OpenPublish = {
      socket,
      from,
      lastVibesAt: Date.now(),
      idleTimer: undefined,
    };
    onAir = publish;
    arm(publish);
    return publish;
  }

  /** Empty the slot and stop its clock. The socket is the caller's business. */
  function clearAir(): void {
    if (onAir === undefined) return;
    disarm(onAir);
    onAir = undefined;
  }

  /**
   * Set the clock for the publish on the air.
   *
   * One timer, re-armed for whatever is left of the interval rather than reset
   * on every media message: RTMP carries media many times a second and a timer
   * rescheduled that often is churn for nothing. Media only writes a
   * timestamp; this decides, when the timer finally fires, whether that
   * timestamp is old enough to matter and otherwise waits out the remainder.
   */
  function arm(publish: OpenPublish): void {
    disarm(publish);
    const remaining = publish.lastVibesAt + idleMs - Date.now();
    if (remaining <= 0) {
      expire(publish);
      return;
    }
    publish.idleTimer = setTimeout(() => arm(publish), remaining);
    // The listener's own handle is what keeps the process alive; a station
    // waiting on this clock and nothing else is a station that should exit.
    publish.idleTimer.unref();
  }

  function disarm(publish: OpenPublish): void {
    if (publish.idleTimer === undefined) return;
    clearTimeout(publish.idleTimer);
    publish.idleTimer = undefined;
  }

  /**
   * The idle rule fires: no vibes for the whole interval, so the station goes
   * off the air.
   *
   * The air is given up first and the socket dropped second, so that the
   * publish is off the air before anything downstream can notice — exactly the
   * order `supersede()` uses, and the reason a corpse's `close` arriving later
   * cannot take a station off the air it no longer holds.
   *
   * Dropping the socket is what ends the vibes: the FLV stream closes, the
   * encoder sees the end of its input and flushes, and the window already on
   * disk stays exactly where it was. A broadcaster who reappears afterwards is
   * accepted like any other publish and continues the sequence.
   */
  function expire(publish: OpenPublish): void {
    if (onAir !== publish) return;
    clearAir();
    console.warn(
      `[station-origin] ingest took the station off the air: no vibes for ${String(idleSeconds)}s from ${publish.from ?? 'an unknown address'} — the uplink is gone, however open its socket still looks`
    );
    publish.socket.destroy();
  }

  function isAuthorized(request: RtmpPublishRequest): boolean {
    if (request.streamName === '') return false;
    return streamKeyMatches(streamKey, request.streamName);
  }
}

/** The publish that is on the air, the socket carrying it, and its clock. */
interface OpenPublish {
  socket: Socket;
  /** The publisher's address, for the log line when the clock runs out. */
  from: string | undefined;
  /** When vibes last arrived on it, in epoch milliseconds. */
  lastVibesAt: number;
  /** The pending idle check, if one is armed. */
  idleTimer: NodeJS.Timeout | undefined;
}

/**
 * An FLV stream fed by one publish, with backpressure wired back to the
 * broadcaster's socket: a segmenter that falls behind slows the publisher down
 * rather than growing a buffer until the node runs out of memory.
 */
function flvStream(socket: Socket): { sink: RtmpMediaSink; vibes: Readable } {
  const through = new PassThrough();
  let paused = false;

  return {
    vibes: through,
    sink: {
      write(flv) {
        if (through.write(flv)) return;
        if (paused) return;
        paused = true;
        socket.pause();
        through.once('drain', () => {
          paused = false;
          socket.resume();
        });
      },
      end() {
        through.end();
      },
    },
  };
}

function loadTls(config: IngestTlsConfig): { cert: Buffer; key: Buffer } {
  try {
    return {
      cert: readFileSync(config.certFile),
      key: readFileSync(config.keyFile),
    };
  } catch (error) {
    throw new IngestTlsError(
      `could not read the ingest TLS certificate or key (${config.certFile}, ${config.keyFile}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolveListen();
    });
  });
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the ingest listener bound no port');
  }
  return address.port;
}
