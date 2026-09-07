import { defineConfig } from 'vitest/config';

// The guide's suite is the payment-free guard and nothing else: it reads
// files, so it runs in a plain node environment with no DOM, no browser and
// no build. Component behavior is proven in a real browser by the opt-in
// Playwright specs (#79), never here — `pnpm test` must run on a laptop with
// no browser at all.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
