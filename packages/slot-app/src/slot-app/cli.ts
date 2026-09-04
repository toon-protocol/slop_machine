#!/usr/bin/env node

/**
 * CLI entrypoint for @toon-protocol/slot-app — the bundled entrypoint the
 * image runs (`dist/cli.js`).
 *
 * A thin wrapper around `startSlotApp()`: it reads configuration from flags and
 * the environment, starts the app, and stops it on a signal. There are no ILP
 * or settlement options here and there never will be — the slot app holds no
 * payment code. `--slot-price` is not an exception to that: it is the number
 * the app *reports* at the quote address so a broadcaster learns what a slot
 * costs before buying one, and it is the floor the buy will check the
 * connector's own stated amount against. Charging it is the connector's job,
 * and pricing a route is connector config.
 *
 * Usage:
 *   slot-app --slot-port 3200 --data-dir /data \
 *     --hub-address g.toon.slopmachine --slot-price 1000000 --slot-cap 100 \
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
import {
  DEFAULT_HUB_ADDRESS,
  DEFAULT_SLOT_CAP,
  DEFAULT_SLOT_PERIOD_SECONDS,
  DEFAULT_SLOT_PRICE,
} from '../slot/policy.js';
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
  --hub-address <addr>   The hub's own ILP address (default:
                         ${DEFAULT_HUB_ADDRESS}; env: TOON_HUB_ADDRESS).
                         Every prefix this hub grants sits directly beneath it,
                         so it has to be an address this hub's own connector
                         actually terminates
  --slot-price <amount>  What a slot costs for one period, in the settlement
                         token's smallest unit (default: ${DEFAULT_SLOT_PRICE};
                         env: TOON_SLOT_PRICE). Reported by the quote so a
                         broadcaster learns the cost before buying; nothing
                         here charges it — pricing a route is connector config,
                         and this number and the connector's buy route are one
                         pair to change together
  --slot-period-seconds <n>
                         How long one purchase lasts, in seconds (default:
                         ${DEFAULT_SLOT_PERIOD_SECONDS}, i.e. 30 days; env:
                         TOON_SLOT_PERIOD_SECONDS). Buying again extends it
  --slot-cap <n>         How many slots may be held at once (default:
                         ${DEFAULT_SLOT_CAP}; env: TOON_SLOT_CAP). This is the
                         hub's collateral bound: every admission opens a
                         channel the hub fronts collateral toward. 0 is a legal
                         policy and means admitting nobody
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
  /quote    PAID, at a floor price, beneath its own connector prefix

/health has no route on the hub's connector and never may: the app port is
published on no interface, which is what makes "unpriced" mean "in-node" rather
than "free to the internet". /quote does have one, at its own prefix and never
the buy's, so neither address is ever reachable at the other's price.
`.trim()
  );
}

/**
 * Parse a whole number or fail closed. A policy number that silently became
 * `NaN` would be a hub quoting nonsense rather than a hub that did not start.
 */
function parseWhole(raw: string, source: string, min: number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    console.error(
      `[slot-app] ${source} must be a whole number of at least ${String(min)}: ${raw}`
    );
    process.exit(1);
  }
  return value;
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
      'hub-address': { type: 'string' },
      'slot-price': { type: 'string' },
      'slot-period-seconds': { type: 'string' },
      'slot-cap': { type: 'string' },
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

  // The hub's admission policy. All four are ordinary configuration, resolved
  // flags over environment over defaults like everything else — admission here
  // is a price rather than a judgement, so these numbers ARE the policy, and
  // changing one must never be a code change.
  const hubAddress = values['hub-address'] ?? env['TOON_HUB_ADDRESS'];
  if (hubAddress) config.hubAddress = hubAddress;

  const price = values['slot-price'] ?? env['TOON_SLOT_PRICE'];
  if (price) config.slotPrice = parseWhole(price, '--slot-price', 1);

  const period =
    values['slot-period-seconds'] ?? env['TOON_SLOT_PERIOD_SECONDS'];
  if (period) {
    config.slotPeriodSeconds = parseWhole(period, '--slot-period-seconds', 1);
  }

  // Zero is a policy an operator may state, so the guard is "at least 0" and
  // the `!== undefined` test is what keeps an explicit 0 from being read as
  // "unset" and quietly replaced by the default.
  const cap = values['slot-cap'] ?? env['TOON_SLOT_CAP'];
  if (cap !== undefined && cap !== '') {
    config.slotCap = parseWhole(cap, '--slot-cap', 0);
  }

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
  if (
    err instanceof Error &&
    (err.name === 'OperatorCredentialError' || err.name === 'SlotPolicyError')
  ) {
    console.error(`[slot-app] ${err.name}: ${err.message}`);
    process.exit(1);
  }
  console.error('[slot-app] failed to start:', err);
  process.exit(1);
});
