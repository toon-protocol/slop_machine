// The slot app's version, as a build-time substitution.
//
// `package.json` is the only place the version is written. Anything that
// compiles or runs `src/version.ts` substitutes `__SLOT_APP_VERSION__` from
// here, so a bundled image reports the version it was cut from and a
// hand-copied constant can never drift out of step with it.
//
// Three consumers, all importing this one file rather than re-reading
// package.json themselves: this package's tsup.config.ts (the shipped bundle),
// its vitest.config.ts, and the root vitest.config.ts — which applies this
// define alongside the station origin's, because one suite run covers both
// packages. Plain ESM so every one of them can import it without a build step.

import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string };

/** esbuild/vite `define` entry substituting src/version.ts's placeholder. */
export const slotAppVersionDefine: Record<string, string> = {
  __SLOT_APP_VERSION__: JSON.stringify(version),
};
