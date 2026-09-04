import { defineConfig } from 'vitest/config';
import { stationOriginVersionDefine } from './version-define';

export default defineConfig({
  define: stationOriginVersionDefine,
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120_000,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
