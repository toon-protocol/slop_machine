/**
 * Which relay the guide reads. One hub per deployment in v1, so this is one
 * URL: `VITE_RELAY_URL` at build time, falling back to the devnet's own free
 * read surface — the loopback publish `pnpm demo` makes, so a guide served
 * beside a running demo finds real announcements with no configuration at
 * all.
 *
 * The guide speaks only the relay's free NIP-01 reads over this socket —
 * never a write, and never anything paid. Being reachable is what costs;
 * being found is free by design.
 */

const DEVNET_RELAY_URL = 'ws://127.0.0.1:7100';

function configured(): string | undefined {
  const value: unknown = import.meta.env['VITE_RELAY_URL'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The relay's free read surface, as one resolved URL. */
export const RELAY_URL: string = configured() ?? DEVNET_RELAY_URL;
