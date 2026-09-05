/**
 * Driving the devnet's compose project.
 *
 * Everything here is mechanism: bringing services up, tearing them down with
 * their volumes, and leaving the logs of a failed run behind. The facts a run
 * asserts live in `devnet.test.ts` beside it, and the topology itself lives in
 * `docker-compose.yml` — this file names no port, no address and no price.
 *
 * Two things it does own, because they are properties of running the bundle
 * rather than of the bundle:
 *
 * - **The daemon check.** With nothing answering on the Docker socket, every
 *   later step fails in a way that reads like a bug in the devnet. It is
 *   checked once, first, and said plainly.
 * - **The connector pin.** `deploy/docker-compose.yml`'s connector `image:` is
 *   the pin of record and the only place in this repository a connector build
 *   may be named — `deploy/bundle.test.ts` fails on a third site. So the pin is
 *   READ from there and passed in as `DEVNET_CONNECTOR_IMAGE`, which the
 *   devnet's own compose file declares as a required variable with no default.
 *   The devnet therefore runs exactly the connector the two shipped bundles
 *   pin, and cannot drift away from it.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** This bundle, and the compose file that is the whole topology. */
export const DEVNET_DIR = resolve(REPO_ROOT, 'deploy/devnet');
const COMPOSE_FILE = resolve(DEVNET_DIR, 'docker-compose.yml');

/** The pin of record. The only file in this repository a connector build is named in. */
const PIN_OF_RECORD = resolve(REPO_ROOT, 'deploy/docker-compose.yml');

/** The variable the devnet's compose file requires, and this module supplies. */
const CONNECTOR_IMAGE_VAR = 'DEVNET_CONNECTOR_IMAGE';

/** A `docker` that answered nothing, said as the one sentence that explains the run. */
export class DevnetDockerError extends Error {
  override readonly name = 'DevnetDockerError';
}

/** A `docker compose` that failed, with the output that says why. */
export class DevnetComposeError extends Error {
  override readonly name = 'DevnetComposeError';
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

/**
 * THE ONLY BINARY THE DEVNET EVER SPAWNS.
 *
 * Not `forge`, not `anvil`, not `cast`, not `git`: Docker and this
 * repository's own toolchain are the whole prerequisite for a run, which is
 * why the settlement contracts are replayed with `viem` from committed
 * artifacts rather than deployed by a script that would need a contracts tree
 * and two submodules. `bundle.test.ts` holds that still.
 */
const DOCKER = 'docker';

async function docker(
  args: string[],
  options: { timeoutMs: number; env?: Record<string, string> }
): Promise<CommandResult> {
  return execFileAsync(DOCKER, args, {
    cwd: DEVNET_DIR,
    timeout: options.timeoutMs,
    // A compose build's output is large, and truncating it would truncate the
    // one thing a red run has to hand its reader.
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
}

/**
 * The pin of record, read rather than copied.
 *
 * A second copy of a connector build in this repository is a copy that drifts,
 * and drift is how an operator deploys one connector while reading about
 * another. The devnet has no pin of its own for exactly that reason.
 */
export function connectorPinOfRecord(): string {
  const compose = parseYaml(readFileSync(PIN_OF_RECORD, 'utf8')) as {
    services?: Record<string, { image?: string }>;
  };
  const pinned = compose.services?.['connector']?.image;

  if (pinned === undefined || pinned.length === 0) {
    throw new DevnetComposeError(
      `deploy/docker-compose.yml's connector service names no image. That file is the pin of record and the only place in this repository a connector build may be named, so the devnet has nothing to run.`
    );
  }
  return pinned;
}

/**
 * Refuse the run, in one sentence, if nothing is answering on the Docker
 * socket.
 *
 * Without this the first `docker compose` failure is what a reader sees, and
 * "cannot connect to the Docker daemon" buried in a compose stack trace reads
 * like the devnet is broken rather than like Docker is not running.
 */
export async function requireDockerDaemon(): Promise<string> {
  try {
    const { stdout } = await docker(
      ['version', '--format', '{{.Server.Version}}'],
      { timeoutMs: 30_000 }
    );
    return stdout.trim();
  } catch (cause) {
    throw new DevnetDockerError(
      `no Docker daemon answered, so the devnet cannot run. It brings a chain and four containers up, which is the whole point of it — there is no mode that runs without one. Start Docker and try again. (\`pnpm test\` needs no daemon; this is \`pnpm test:devnet\`.) The underlying error was: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }
}

/** One `docker compose` invocation against this bundle, with the pin supplied. */
export async function compose(
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<CommandResult> {
  try {
    return await docker(['compose', '-f', COMPOSE_FILE, ...args], {
      timeoutMs: options.timeoutMs ?? 600_000,
      env: { [CONNECTOR_IMAGE_VAR]: connectorPinOfRecord() },
    });
  } catch (cause) {
    const failure = cause as { stdout?: string; stderr?: string };
    throw new DevnetComposeError(
      `\`docker compose ${args.join(' ')}\` failed.\n${failure.stderr ?? ''}\n${failure.stdout ?? ''}`
    );
  }
}

/**
 * Bring services up and WAIT FOR THEM TO BE HEALTHY.
 *
 * `--wait` rather than a poll of our own: every service in this bundle
 * declares a healthcheck, so compose already knows the answer, and a service
 * that never becomes healthy fails here rather than three assertions later
 * against a node that was never up.
 */
export async function up(services: string[]): Promise<void> {
  await compose(['up', '-d', '--wait', ...services]);
}

/**
 * Restart one service, and wait for it to be healthy again.
 *
 * This is the third step of the documented broadcaster order — quote,
 * configure, RESTART — and it is a restart rather than a recreate because that
 * is what an operator does: the configuration is a bind mount, so the file the
 * node re-reads at boot is the file that was just rewritten under it.
 *
 * The wait is not optional. A restart returns as soon as the container is
 * running, and a connector that is running has not necessarily read its config,
 * resolved its token network against the chain, or bound its listener — so
 * asserting against it too early is asserting against the node that was.
 */
export async function restart(service: string): Promise<void> {
  await compose(['restart', service]);
  await compose(['up', '-d', '--wait', service]);
}

/**
 * Everything, gone — containers, networks AND volumes, so a second run starts
 * from the same place as the first.
 *
 * `--volumes` is the load-bearing flag. The connectors' claim journals and the
 * hub's roster are named volumes, and a run that inherited either would be
 * asserting against a chain that no longer holds what they remember.
 */
export async function down(): Promise<void> {
  await compose(['down', '--volumes', '--remove-orphans', '--timeout', '5'], {
    timeoutMs: 180_000,
  });
}

/**
 * Every service's logs, for a run that failed.
 *
 * A red CI job has to be diagnosable without re-running it locally, and by the
 * time anybody reads it the containers are gone.
 */
export async function logs(): Promise<string> {
  try {
    const { stdout, stderr } = await compose(
      ['logs', '--no-color', '--timestamps'],
      {
        timeoutMs: 120_000,
      }
    );
    return `${stdout}${stderr}`;
  } catch (cause) {
    // A failure to collect the logs must not replace the failure that made us
    // want them.
    return `the devnet's logs could not be collected: ${
      cause instanceof Error ? cause.message : String(cause)
    }`;
  }
}
