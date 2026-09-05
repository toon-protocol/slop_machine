import { defineConfig } from 'vitest/config';

/**
 * The devnet run — `pnpm test:devnet`, deliberately not `pnpm test`.
 *
 * `deploy/devnet/` brings a chain and both node shapes up in containers and
 * drives the whole documented path across them. That needs a Docker daemon and
 * takes minutes, so it is excluded from the everyday suite's include list and
 * run from here instead — the same split `vitest.image.config.ts` already
 * makes for the image-secrets guard, and for the same reason: the ordinary
 * suite must keep running with no daemon at all.
 *
 * The devnet's own BUNDLE GUARD is not here. It reads the committed files,
 * needs nothing, and runs in `pnpm test` beside its two sibling guards — so a
 * broken compose file fails in seconds rather than after a chain has booted.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // `preflight.test.ts` needs no daemon and states what the run says when
    // there is not one; `devnet.test.ts` is the run. Named by file rather than
    // by glob, because `bundle.test.ts` sits in the same directory and belongs
    // to the other suite.
    include: [
      'deploy/devnet/preflight.test.ts',
      'deploy/devnet/devnet.test.ts',
    ],
    // A run pulls a chain image, builds two app images and encodes real vibes
    // through a real ingest. Slower than this is a broken run, not a slow one.
    testTimeout: 600_000,
    hookTimeout: 900_000,
    // ONE topology, one set of host ports, one compose project. Two files
    // running at once would tear down each other's containers.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    // A run's own log is the diagnosis a red CI job leaves behind, so nothing
    // it prints is swallowed.
    disableConsoleIntercept: true,
  },
});
