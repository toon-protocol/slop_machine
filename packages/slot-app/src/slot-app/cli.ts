#!/usr/bin/env node

/**
 * CLI entrypoint for @toon-protocol/slot-app — the bundled entrypoint the
 * image runs (`dist/cli.js`).
 *
 * A thin wrapper around `startSlotApp()`: it reads configuration from flags and
 * the environment, starts the app, and stops it on a signal. There are no ILP,
 * settlement or pricing options here, and there never will be — the slot app
 * holds no payment code, and pricing a route is connector config.
 *
 * Usage:
 *   slot-app --slot-port 3200 --data-dir /data \
 *     --operator-write-key-file /run/secrets/operator-write.key \
 *     --operator-bearer-token-file /run/secrets/operator-bearer.token
 *   TOON_OPERATOR_WRITE_KEY_FILE=... TOON_OPERATOR_BEARER_TOKEN_FILE=... slot-app
 *
 * Flags override environment variables, which override defaults — exactly as
 * the station origin resolves its own configuration. The two operator
 * credentials are the exception with no default: each is named by PATH only,
 * and there is no flag and no environment variable carrying either literal,
 * because a command line is world-readable on the box and an image's
 * environment is readable from its metadata.
 *
 * @module
 */

import { parseArgs } from 'node:util';
import {
  startSlotApp,
  DEFAULT_SLOT_PORT,
  DEFAULT_HOST,
  DEFAULT_DATA_DIR,
} from './slot-app.js';
import type { SlotAppConfig } from './slot-app.js';
import { VERSION } from '../version.js';

function printHelp(): void {
  console.log(
    `
Usage: slot-app [options]

Options:
  --slot-port <port>     Port the slot app serves on (default: ${DEFAULT_SLOT_PORT};
                         env: TOON_SLOT_PORT). Never publish this port to a
                         host interface — a hub publishes Caddy's 80 and 443
                         and nothing else, and the app is reached over the
                         compose network by its own connector. 0 binds an
                         ephemeral port
  --host <host>          Bind host for that port (default: ${DEFAULT_HOST};
                         env: TOON_SLOT_HOST)
  --data-dir <path>      Directory the app owns on disk (default:
                         ${DEFAULT_DATA_DIR}; env: TOON_DATA_DIR)
  --operator-write-key-file <p>
                         File holding the hub's operator WRITE KEY (env:
                         TOON_OPERATOR_WRITE_KEY_FILE). Required; there is no
                         default and no form of this that takes the key
                         itself. Every operator write the app makes is
                         signature-gated with it, which is what makes the
                         write attributable to the app rather than to the
                         operator's own hand
  --operator-bearer-token-file <p>
                         File holding the hub's operator BEARER TOKEN (env:
                         TOON_OPERATOR_BEARER_TOKEN_FILE). Required, on the
                         same terms: it gates the reads the app makes against
                         the operator surface
  --version              Print the version and exit
  --help                 Print this help and exit

Both credentials are read from their mounted files at startup and neither is
ever logged, echoed, or reported back. THE APP REFUSES TO START without either,
naming the one that is wrong — a hub that cannot admit anybody must look broken
rather than look fine.

  /health   unpriced process liveness, for a supervisor inside the node

It has no route on the hub's connector and never may: the app port is published
on no interface, which is what makes "unpriced" mean "in-node" rather than
"free to the internet".
`.trim()
  );
}

/** Parse a port or fail closed — a bad number must never become a silent 0. */
function parsePort(raw: string, source: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[slot-app] ${source} is not a valid port: ${raw}`);
    process.exit(1);
  }
  return port;
}

function configFromEnvironment(
  argv: string[],
  env: NodeJS.ProcessEnv
): SlotAppConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      'slot-port': { type: 'string' },
      host: { type: 'string' },
      'data-dir': { type: 'string' },
      'operator-write-key-file': { type: 'string' },
      'operator-bearer-token-file': { type: 'string' },
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

  const config: SlotAppConfig = {};

  const portFlag = values['slot-port'];
  const portEnv = env['TOON_SLOT_PORT'];
  if (portFlag !== undefined) {
    config.slotPort = parsePort(portFlag, '--slot-port');
  } else if (portEnv !== undefined && portEnv !== '') {
    config.slotPort = parsePort(portEnv, 'TOON_SLOT_PORT');
  }

  const host = values.host ?? env['TOON_SLOT_HOST'];
  if (host) config.host = host;

  const dataDir = values['data-dir'] ?? env['TOON_DATA_DIR'];
  if (dataDir) config.dataDir = dataDir;

  // Paths only, for both. A credential literal has no flag and no environment
  // variable on purpose: a command line is world-readable on the box and an
  // image's environment is readable from its metadata by anyone who pulls it.
  // A path is not a secret; the file it names is.
  const writeKeyFile =
    values['operator-write-key-file'] ?? env['TOON_OPERATOR_WRITE_KEY_FILE'];
  if (writeKeyFile) config.operatorWriteKeyFile = writeKeyFile;

  const bearerTokenFile =
    values['operator-bearer-token-file'] ??
    env['TOON_OPERATOR_BEARER_TOKEN_FILE'];
  if (bearerTokenFile) config.operatorBearerTokenFile = bearerTokenFile;

  return config;
}

async function main(): Promise<void> {
  const app = await startSlotApp(
    configFromEnvironment(process.argv.slice(2), process.env)
  );

  const shutdown = (signal: string) => {
    console.log(`[slot-app] ${signal} — stopping`);
    app.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error('[slot-app] failed to stop cleanly:', err);
        process.exit(1);
      }
    );
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // A named configuration error is the operator's mistake, not a crash — say
  // what is wrong and stop, rather than printing a stack over it. The message
  // names the credential and its path; it never carries either value.
  if (err instanceof Error && err.name === 'OperatorCredentialError') {
    console.error(`[slot-app] ${err.name}: ${err.message}`);
    process.exit(1);
  }
  console.error('[slot-app] failed to start:', err);
  process.exit(1);
});
