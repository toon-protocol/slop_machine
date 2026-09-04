#!/usr/bin/env node

/**
 * CLI entrypoint for @toon-protocol/station-origin — the bundled entrypoint
 * the image runs (`dist/cli.js`).
 *
 * A thin wrapper around `startOrigin()`: it reads configuration from flags and
 * the environment, starts the origin, and stops it on a signal. There are no
 * connector, ILP, settlement or pricing options here, and there never will be
 * — the origin holds no payment code, and pricing a route is connector config.
 *
 * Usage:
 *   station-origin --segment-port 3100 --data-dir /data --stream-key-file /run/secrets/station.key
 *   TOON_STREAM_KEY_FILE=/run/secrets/station.key station-origin
 *
 * Flags override environment variables, which override defaults. The stream
 * key is the exception with no default and no flag carrying the literal: it is
 * a mounted value, and a key passed on a command line is a key in every
 * process listing on the box.
 *
 * @module
 */

import { parseArgs } from 'node:util';
import {
  startOrigin,
  DEFAULT_SEGMENT_PORT,
  DEFAULT_HOST,
  DEFAULT_DATA_DIR,
  DEFAULT_INGEST_PORT,
  DEFAULT_INGEST_HOST,
  DEFAULT_RUNG,
  DEFAULT_SEGMENT_SECONDS,
} from './origin.js';
import type { OriginConfig } from './origin.js';
import { VERSION } from '../version.js';

function printHelp(): void {
  console.log(
    `
Usage: station-origin [options]

Options:
  --segment-port <port>  Port the origin serves on (default: ${DEFAULT_SEGMENT_PORT};
                         env: TOON_SEGMENT_PORT). Never publish this port to a
                         host interface — the only route to a station's vibes
                         is a paid packet through its connector. 0 binds an
                         ephemeral port
  --host <host>          Bind host for that port (default: ${DEFAULT_HOST};
                         env: TOON_SEGMENT_HOST)
  --data-dir <path>      Directory the origin owns on disk (default:
                         ${DEFAULT_DATA_DIR}; env: TOON_DATA_DIR). Segments are
                         written to <path>/segments/<rung>/
  --segment-seconds <n>  How long each segment is, in whole seconds (default:
                         ${DEFAULT_SEGMENT_SECONDS}; env: TOON_SEGMENT_SECONDS). Fixed on
                         purpose: a flat per-segment price is only honestly a
                         per-second rate when every segment covers the same
                         span
  --ingest-port <port>   Port a broadcaster publishes to (default:
                         ${DEFAULT_INGEST_PORT}; env: TOON_INGEST_PORT). This port IS
                         published by the station node — stock Caddy does not
                         speak RTMP. 0 binds an ephemeral port
  --ingest-host <host>   Bind host for the ingest port (default:
                         ${DEFAULT_INGEST_HOST}; env: TOON_INGEST_HOST)
  --stream-key-file <p>  File holding the station's stream key (env:
                         TOON_STREAM_KEY_FILE). Required unless TOON_STREAM_KEY
                         is set; there is no default and the origin refuses to
                         start without one
  --ingest-tls-cert <p>  Certificate chain for the ingest port, in PEM (env:
                         TOON_INGEST_TLS_CERT). With --ingest-tls-key, ingest
                         is RTMPS; without both, it is plain RTMP
  --ingest-tls-key <p>   Private key for that certificate, in PEM (env:
                         TOON_INGEST_TLS_KEY)
  --version              Print the version and exit
  --help                 Print this help and exit

The stream key is read from the mounted file at startup and is never logged,
echoed, or reported back. A broadcaster publishes with it as their stream name:

  rtmps://<station>:${DEFAULT_INGEST_PORT}/live/<stream key>

which is exactly the Server/Stream Key pair OBS asks for.

The station offers one rung, ${DEFAULT_RUNG.name}, and serves its segments at

  /segments/${DEFAULT_RUNG.name}/<sequence>.ts

on the segment port. The configurable rung ladder is not built yet, so there is
deliberately no flag for it rather than one that will change shape.
`.trim()
  );
}

/** Parse a port or fail closed — a bad number must never become a silent 0. */
function parsePort(raw: string, source: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[station-origin] ${source} is not a valid port: ${raw}`);
    process.exit(1);
  }
  return port;
}

/** Parse a segment duration or fail closed — a bad number must not become 0. */
function parseSeconds(raw: string, source: string): number {
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    console.error(
      `[station-origin] ${source} must be a whole number of seconds: ${raw}`
    );
    process.exit(1);
  }
  return seconds;
}

/** A config error the operator can act on, rather than a stack trace. */
function refuse(message: string): never {
  console.error(`[station-origin] ${message}`);
  process.exit(1);
}

function configFromEnvironment(
  argv: string[],
  env: NodeJS.ProcessEnv
): OriginConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      'segment-port': { type: 'string' },
      host: { type: 'string' },
      'data-dir': { type: 'string' },
      'segment-seconds': { type: 'string' },
      'ingest-port': { type: 'string' },
      'ingest-host': { type: 'string' },
      'stream-key-file': { type: 'string' },
      'ingest-tls-cert': { type: 'string' },
      'ingest-tls-key': { type: 'string' },
      version: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }
  if (values.version) {
    console.log(VERSION);
    process.exit(0);
  }

  const config: OriginConfig = {};

  const portFlag = values['segment-port'];
  const portEnv = env['TOON_SEGMENT_PORT'];
  if (portFlag !== undefined) {
    config.segmentPort = parsePort(portFlag, '--segment-port');
  } else if (portEnv !== undefined && portEnv !== '') {
    config.segmentPort = parsePort(portEnv, 'TOON_SEGMENT_PORT');
  }

  const host = values.host ?? env['TOON_SEGMENT_HOST'];
  if (host) config.host = host;

  const dataDir = values['data-dir'] ?? env['TOON_DATA_DIR'];
  if (dataDir) config.dataDir = dataDir;

  const secondsFlag = values['segment-seconds'];
  const secondsEnv = env['TOON_SEGMENT_SECONDS'];
  if (secondsFlag !== undefined) {
    config.segmentSeconds = parseSeconds(secondsFlag, '--segment-seconds');
  } else if (secondsEnv !== undefined && secondsEnv !== '') {
    config.segmentSeconds = parseSeconds(secondsEnv, 'TOON_SEGMENT_SECONDS');
  }

  const ingestPortFlag = values['ingest-port'];
  const ingestPortEnv = env['TOON_INGEST_PORT'];
  if (ingestPortFlag !== undefined) {
    config.ingestPort = parsePort(ingestPortFlag, '--ingest-port');
  } else if (ingestPortEnv !== undefined && ingestPortEnv !== '') {
    config.ingestPort = parsePort(ingestPortEnv, 'TOON_INGEST_PORT');
  }

  const ingestHost = values['ingest-host'] ?? env['TOON_INGEST_HOST'];
  if (ingestHost) config.ingestHost = ingestHost;

  // The key literal has no flag on purpose: a command line is world-readable
  // on the box. A path is not a secret; the file it names is.
  const streamKeyFile =
    values['stream-key-file'] ?? env['TOON_STREAM_KEY_FILE'];
  if (streamKeyFile) config.streamKeyFile = streamKeyFile;
  const streamKey = env['TOON_STREAM_KEY'];
  if (streamKey) config.streamKey = streamKey;

  const tlsCert = values['ingest-tls-cert'] ?? env['TOON_INGEST_TLS_CERT'];
  const tlsKey = values['ingest-tls-key'] ?? env['TOON_INGEST_TLS_KEY'];
  if (tlsCert && tlsKey) {
    config.ingestTls = { certFile: tlsCert, keyFile: tlsKey };
  } else if (tlsCert || tlsKey) {
    // Half a TLS configuration would quietly downgrade ingest to plain RTMP,
    // which is the one outcome an operator setting either flag did not want.
    refuse(
      'ingest TLS needs both a certificate and a key; set --ingest-tls-cert/TOON_INGEST_TLS_CERT and --ingest-tls-key/TOON_INGEST_TLS_KEY, or neither'
    );
  }

  return config;
}

async function main(): Promise<void> {
  const origin = await startOrigin(
    configFromEnvironment(process.argv.slice(2), process.env)
  );

  const shutdown = (signal: string) => {
    console.log(`[station-origin] ${signal} — stopping`);
    origin.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error('[station-origin] failed to stop cleanly:', err);
        process.exit(1);
      }
    );
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // A named configuration error is the operator's mistake, not a crash — say
  // what is wrong and stop, rather than printing a stack over it.
  if (
    err instanceof Error &&
    (err.name === 'StreamKeyError' ||
      err.name === 'IngestTlsError' ||
      err.name === 'RungError')
  ) {
    console.error(`[station-origin] ${err.name}: ${err.message}`);
    process.exit(1);
  }
  console.error('[station-origin] failed to start:', err);
  process.exit(1);
});
