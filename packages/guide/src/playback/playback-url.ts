/**
 * Where the guide looks for a paying side — the playback contract's loopback
 * surface (ADR 0005). One URL: `VITE_PLAYBACK_URL` at build time, falling
 * back to the devnet demo's own page port, so a guide served beside a running
 * `pnpm demo` finds the contract with no configuration at all.
 *
 * The guide only ever *detects* what answers here. Failure to reach it is not
 * an error: it is the hosted mode, where the same affordances render an
 * explanation of how to vibe instead of a player.
 */

const DEVNET_PLAYBACK_URL = 'http://127.0.0.1:8088';

function configured(): string | undefined {
  const value: unknown = import.meta.env['VITE_PLAYBACK_URL'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The paying side's contract surface, as one resolved base URL. */
export const PLAYBACK_URL: string = configured() ?? DEVNET_PLAYBACK_URL;
