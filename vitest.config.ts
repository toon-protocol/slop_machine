import { defineConfig } from 'vitest/config';
import { stationOriginVersionDefine } from './packages/station-origin/version-define';
import { slotAppVersionDefine } from './packages/slot-app/version-define';

export default defineConfig({
  // This config runs every package's suites, so it needs the same build-time
  // version substitution each of those packages applies to its own bundle.
  // One `define` for both: each names its own placeholder, so a package added
  // here adds a line rather than replacing one.
  define: { ...stationOriginVersionDefine, ...slotAppVersionDefine },
  test: {
    globals: true,
    environment: 'node',
    // The origin's suite boots the real app and (from issue #7 onward) does
    // real encoding, so the default 5s timeout is far too tight.
    testTimeout: 120_000,
    pool: 'forks',
    poolOptions: {
      forks: { minForks: 1, maxForks: 4 },
    },
    // Every workspace package's own suites, plus deploy/*.test.ts — the guard
    // that reads the real deploy artifacts (it is not app source, so it
    // lives next to the files it guards, exactly as relay's does).
    include: ['packages/*/src/**/*.test.ts', 'deploy/*.test.ts'],
    // deploy/image-secrets.test.ts is the one exception: it needs a Docker
    // daemon and builds real images, so it runs from vitest.image.config.ts
    // via `pnpm test:image` rather than adding minutes to every run here.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'deploy/image-secrets.test.ts',
    ],
  },
});
