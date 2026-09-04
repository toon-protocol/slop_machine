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
 *   station-origin --segment-port 3100 --data-dir /data
 *   TOON_SEGMENT_PORT=3100 TOON_DATA_DIR=/data station-origin
 *
 * Flags override environment variables, which override defaults.
 *
 * @module
 */

import { parseArgs } from 'node:util';
import {
  startOrigin,
  DEFAULT_SEGMENT_PORT,
  DEFAULT_HOST,
  DEFAULT_DATA_DIR,
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
                         ${DEFAULT_DATA_DIR}; env: TOON_DATA_DIR)
  --version              Print the version and exit
  --help                 Print this help and exit
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
  console.error('[station-origin] failed to start:', err);
  process.exit(1);
});
