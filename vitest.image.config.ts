import { defineConfig } from 'vitest/config';

/**
 * The image suite — `pnpm test:image`, deliberately not `pnpm test`.
 *
 * `deploy/image-secrets.test.ts` plants dummy key material beside the deploy
 * bundle and builds real images to prove none of it reaches the build context
 * or the published image. That needs a Docker daemon and takes minutes, so it
 * is excluded from the everyday suite's include list and run from here
 * instead. The fast half of the same guard — that `.dockerignore` still names
 * the patterns — is in `deploy/bundle.test.ts` and runs with everything else.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['deploy/image-secrets.test.ts'],
    // Building the origin image installs ffmpeg and two dependency trees on a
    // cold cache. A build slower than this is a broken build, not a slow one.
    testTimeout: 900_000,
    hookTimeout: 120_000,
    // The suite plants files in the working tree and builds from it, so
    // nothing else may be building from the same tree at the same time.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
