/**
 * The roster address: who holds a slot on this hub, and when each lapses.
 *
 * ```
 * GET /roster
 * ```
 *
 * **Unpriced, and it has no route on the hub's connector and never may.** That
 * sentence is the whole security model of this address and of `/health` beside
 * it. The app port is published on no interface — a hub publishes exactly
 * Caddy's 80 and 443 — so an address with no connector route in front of it is
 * reachable from inside the node and from nowhere else. Give it a route and it
 * becomes two things at once that it must never be: on sale, and on the
 * internet. #41's bundle guard asserts that no route in the committed
 * `connector.toml` names this path, so keeping the path stable is part of
 * keeping that guard meaningful.
 *
 * **It reads no payment header and requires none.** Not "it tolerates their
 * absence": there is no `X-TOON-Payer` here, no amount, no chain, and nothing
 * to refuse — this is the hub operator asking their own process a question, on
 * a port only they can reach. The two paid addresses read those headers because
 * a connector states them; this one has no connector in front of it to state
 * anything.
 *
 * What it answers is the question a hub operator would otherwise answer by
 * reading a database by hand: who is admitted, at what address, until when,
 * and **what this hub has funded for them**. That last is the whole reason
 * the roster records a channel at all: `slotCap` bounds a balance-sheet
 * commitment, and an operator who could only multiply two configured numbers
 * together would be reading their intention rather than their exposure.
 *
 * It is a **view of the roster**, not of the connector's routing table —
 * what the hub sold rather than what it is carrying. The two are made to agree
 * at boot (`../reconcile/reconcile.ts`), and where they disagree in between it
 * is this record that says which of them is right.
 *
 * @module
 */

import { Hono } from 'hono';
import { grantedPrefix } from './handle.js';
import type { SlotPolicy } from './policy.js';
import type { SlotRoster } from './roster.js';

/**
 * Where the roster answers.
 *
 * **Never a connector route.** It sits outside every prefix the hub's
 * connector terminates, exactly as `/health` does, and the bundle guard is
 * what keeps it that way.
 */
export const ROSTER_ROUTE_PATH = '/roster';

/** One slot, as the hub operator reads it back. */
export interface RosterEntry {
  /**
   * The verified payer key the slot is bound to, exactly as the connector
   * stated it — which is *who* holds it. A public channel key, not a secret,
   * and the only identity in this app that was never self-asserted.
   */
  payer: string;
  /** The label the hub granted them. */
  label: string;
  /** The ILP prefix that label is granted at: the hub's address, then it. */
  prefix: string;
  /**
   * When the slot lapses if nobody renews it, in milliseconds since the epoch.
   *
   * Past this the hub takes the addresses and then the peering back out on its
   * own initiative — within one sweep of it while the hub is up, and at boot
   * where it passed while the hub was down.
   */
  lapsesAt: number;
  /**
   * The payment channel this hub funded for that broadcaster, or `null` for a
   * slot recorded before the buy funded anything.
   *
   * This is the hub operator's own money, and the identifier they would need
   * to close and settle it: a lapse stops the carriage and leaves the deposit
   * where it is (ADR 0003's third amendment), so reclaiming capital from a
   * station that went away is a deliberate act against this identifier.
   */
  channelId: string | null;
  /**
   * What that channel held when the slot was last written, in the settlement
   * token's smallest unit, as a decimal string — or `null` beside a `null`
   * {@link RosterEntry.channelId}.
   *
   * Summed across the rows, this is the commitment `slotCap` bounds: the
   * number an operator would otherwise compute from their own configuration
   * and hope was right.
   */
  collateral: string | null;
}

/** What the hub operator reads at {@link ROSTER_ROUTE_PATH}. */
export interface RosterView {
  /** The hub's own ILP address, which every granted prefix sits beneath. */
  hubAddress: string;
  /** How many slots may be held at once — the operator's own cap. */
  slotCap: number;
  /** How many are held right now. */
  slotsHeld: number;
  /**
   * Every slot held, soonest to lapse first.
   *
   * Ordered so that the row an operator most likely came to look at — the next
   * one to go — is the first one they read, rather than whichever the roster
   * happened to hand over first.
   */
  slots: RosterEntry[];
  /** When this answer was made, in milliseconds since the epoch. */
  timestamp: number;
}

/** What the roster address needs to answer. */
export interface RosterViewDependencies {
  /** The hub's admission policy: its own address and its cap. */
  policy: SlotPolicy;
  /** The roster itself — read, never written. */
  roster: SlotRoster;
}

/**
 * The route that shows the roster, to be mounted at
 * {@link ROSTER_ROUTE_PATH}.
 *
 * Always a `200`: an empty hub is an answer, not an error, and there is
 * nothing here a caller can get wrong.
 */
export function rosterRoutes(deps: RosterViewDependencies): Hono {
  const routes = new Hono();

  routes.get('/', (c) => {
    const { policy, roster } = deps;

    const view: RosterView = {
      hubAddress: policy.hubAddress,
      slotCap: policy.slotCap,
      slotsHeld: roster.size(),
      slots: roster
        .held()
        .map((slot) => ({
          payer: slot.payer,
          label: slot.label,
          prefix: grantedPrefix(policy.hubAddress, slot.label),
          lapsesAt: slot.lapsesAt,
          // `null` rather than absent, and rather than `0`: a slot recorded
          // before the buy funded anything is a slot whose funding this hub
          // does not know, which is a different fact from a channel holding
          // nothing. It is left that way until its next renewal.
          channelId: slot.channelId ?? null,
          collateral: slot.collateral ?? null,
        }))
        .sort((one, other) => one.lapsesAt - other.lapsesAt),
      timestamp: Date.now(),
    };

    // A roster changes whenever anybody buys, renews or lapses, and this is a
    // diagnostic read: an operator handed a cached one would be reading the
    // hub as it was rather than as it is.
    return c.json(view, 200, { 'cache-control': 'no-store' });
  });

  return routes;
}
