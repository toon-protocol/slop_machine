/**
 * What the devnet says when it cannot run at all.
 *
 * `pnpm test:devnet` brings a chain and four containers up; there is no mode
 * that runs without a Docker daemon, and pretending otherwise would mean
 * skipping the run and reporting green. So the daemon is checked FIRST and the
 * refusal is one sentence that names the actual problem — otherwise a reader's
 * first evidence is a compose stack trace, which reads like a broken devnet
 * rather than like Docker not running.
 *
 * This file is the one part of the devnet suite that needs no daemon: it
 * proves the refusal by pointing the client at a socket nothing is listening
 * on. `vitest.devnet.config.ts` runs it first and runs nothing in parallel, so
 * the environment it borrows for one call is nobody else's.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { requireDockerDaemon, DevnetDockerError } from './compose.js';

/** A socket nothing has ever listened on — the shape of "the daemon is not running". */
const A_DEAD_SOCKET = 'unix:///nonexistent/devnet-has-no-docker.sock';

const DOCKER_HOST = 'DOCKER_HOST';

describe('the devnet with no Docker daemon', () => {
  const before = process.env[DOCKER_HOST];

  afterEach(() => {
    // `Reflect.deleteProperty` rather than `delete`: the key is a computed one,
    // and the environment has to come back exactly as it was — the run that
    // follows this file in the same process is the one that needs a daemon.
    if (before === undefined) Reflect.deleteProperty(process.env, DOCKER_HOST);
    else process.env[DOCKER_HOST] = before;
  });

  it('fails hard, and says plainly that no daemon answered', async () => {
    process.env[DOCKER_HOST] = A_DEAD_SOCKET;

    const refusal = await requireDockerDaemon().then(
      (version) => ({ version }),
      (cause: unknown) => ({ cause })
    );

    expect(
      'cause' in refusal,
      `the devnet reported a Docker daemon at a socket nothing is listening on`
    ).toBe(true);

    const cause = (refusal as { cause: unknown }).cause;
    expect(cause).toBeInstanceOf(DevnetDockerError);

    // The message is the whole point of the check: it has to name Docker, say
    // there is no mode without it, and distinguish itself from `pnpm test`,
    // which needs no daemon and is what most readers ran last.
    const message = cause instanceof Error ? cause.message : String(cause);
    for (const said of ['Docker', 'pnpm test:devnet']) {
      expect(
        message,
        `the refusal does not name "${said}", so a reader learns nothing from it: ${message}`
      ).toContain(said);
    }
  });
});
