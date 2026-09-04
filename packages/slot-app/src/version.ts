/**
 * The slot app's version.
 *
 * `__SLOT_APP_VERSION__` is a build-time placeholder substituted from
 * `package.json` by `version-define.ts` — see that file. The fallback below is
 * only reached when this module is executed by a runner that applies no
 * `define` at all; nothing that ships takes it.
 *
 * @module
 */

declare const __SLOT_APP_VERSION__: string | undefined;

/** The version this build was cut from. */
export const VERSION: string =
  typeof __SLOT_APP_VERSION__ === 'string' ? __SLOT_APP_VERSION__ : '0.0.0-dev';
