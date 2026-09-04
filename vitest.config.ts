import { defineConfig } from 'vitest/config';
import { stationOriginVersionDefine } from './packages/station-origin/version-define';

export default defineConfig({
  // This config runs the station origin's suites, so it needs the same
  // build-time version substitution that package's own configs apply.
  define: stationOriginVersionDefine,
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
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
