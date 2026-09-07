/**
 * The guide's half of the playback contract (ADR 0005): plain HTTP calls to
 * the loopback surface of whatever pays — the devnet player today, the
 * toon-client daemon eventually. Nothing here is payment code: the paying
 * side holds the money, and across this line the guide only initiates and
 * stops vibing, selects a rung, and reads state.
 *
 * Two rules of the ADR shape everything in this file:
 *
 * - **The budget lives on the paying side of the loopback line, and no
 *   request across it can raise it.** The guide chooses within the budget and
 *   never sets it, so no function here takes or sends one — the field is
 *   read-only in the state, because choosing within a budget requires
 *   knowing it.
 * - **Every amount is a decimal string of base units**, rendered verbatim and
 *   never parsed through a double — the guide computes nothing about money
 *   on its own. Prices, the broadcaster/hub split and the spend totals are
 *   the paying side's own facts, carried whole.
 *
 * Detection is a read: `readPlaybackState` returning `null` means no paying
 * side answered — the hosted mode, not an error. The paying side's origin
 * allowlist gates this too: a guide origin the paying side does not know can
 * neither act nor read, and reads as absent, which is the allowlist working.
 */

import { PLAYBACK_URL } from '@/playback/playback-url';

/** One rung as the contract reports it — every amount a decimal string. */
export interface PlaybackRung {
  rung: string;
  /** What one segment at this rung costs the viber, across the hop. */
  price: string;
  /** Of that, what reaches the broadcaster and what the hub keeps. */
  toStation: string;
  toHub: string;
  /** Where this rung's synthesized playlist is served, on loopback. */
  playlist: string;
  edge: number | null;
  bought: number;
  spent: string;
}

/** The whole of what the guide may know — `GET /contract/v1/state`. */
export interface PlaybackState {
  contract: string;
  /** The one station this paying side can pay. */
  station: string;
  vibing: boolean;
  live: boolean;
  rung: string | null;
  segmentSeconds: number;
  /** The paying side's own figure — readable, never settable, from here. */
  budgetPerSecond: string;
  rungs: PlaybackRung[];
  spent: string;
  toStation: string;
  toHub: string;
  packets: number;
}

const CONTRACT_ROOT = '/contract/v1';

function asState(body: unknown): PlaybackState | null {
  if (typeof body !== 'object' || body === null) return null;
  const state = body as PlaybackState;
  return state.contract === 'v1' ? state : null;
}

/**
 * Read the paying side's state — and, by succeeding or not, detect it.
 * Unreachable, refusing, or speaking a version this guide does not know all
 * come back `null`: the hosted mode.
 */
export async function readPlaybackState(): Promise<PlaybackState | null> {
  try {
    const answer = await fetch(`${PLAYBACK_URL}${CONTRACT_ROOT}/state`);
    if (!answer.ok) return null;
    return asState(await answer.json());
  } catch {
    return null;
  }
}

async function write(
  path: string,
  body?: Record<string, string>
): Promise<PlaybackState | null> {
  try {
    const answer = await fetch(`${PLAYBACK_URL}${CONTRACT_ROOT}${path}`, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    // A write answers with the state, so the guide learns the result from
    // the same shape it learns everything else. A refusal answers null and
    // the next poll tells the truth either way.
    if (!answer.ok) return null;
    return asState(await answer.json());
  } catch {
    return null;
  }
}

/** Initiate vibing with a station. The paying side decides whether it can pay it. */
export function requestVibe(station: string): Promise<PlaybackState | null> {
  return write('/vibe', { station });
}

/** Stop vibing — which stops the spend, because the paying side buys nothing while stopped. */
export function requestStop(): Promise<PlaybackState | null> {
  return write('/stop');
}

/** Select the rung the viber is vibing at. */
export function requestRung(rung: string): Promise<PlaybackState | null> {
  return write('/rung', { rung });
}
