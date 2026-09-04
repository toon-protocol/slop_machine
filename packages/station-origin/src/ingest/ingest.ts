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
 * `ffmpeg` reads from a pipe. Nothing in this repo consumes it yet; the
 * segmenter that will is issue #7.
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
   * Called once per accepted publish, with the vibes attached. Omit it and
   * accepted media is counted and discarded rather than buffered — which is
   * what the origin does until the segmenter exists.
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
  /** Whether a broadcaster is publishing right now. */
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

  const sockets = new Set<Socket>();
  let live = 0;

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
    `[station-origin] ingest listening for ${config.tls ? 'RTMPS' : 'RTMP'} on ${host}:${String(port)}`
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
    isLive() {
      return live > 0;
    },
    async stop() {
      if (!running) return;
      running = false;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolveStop, rejectStop) => {
        server.close((err) => (err ? rejectStop(err) : resolveStop()));
      });
    },
  };

  function attach(socket: Socket): void {
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

        live += 1;
        console.log(
          `[station-origin] ingest accepted a publish on app "${request.app}" from ${request.remoteAddress ?? 'an unknown address'}`
        );

        if (onPublish === undefined) return { accepted: true };

        const { sink, vibes } = flvStream(socket);
        onPublish({
          app: request.app,
          remoteAddress: request.remoteAddress,
          startedAt: Date.now(),
          vibes,
        });
        return { accepted: true, media: sink };
      },
      onPublishEnd(request, bytes) {
        live = Math.max(0, live - 1);
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

  function isAuthorized(request: RtmpPublishRequest): boolean {
    if (request.streamName === '') return false;
    return streamKeyMatches(streamKey, request.streamName);
  }
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
