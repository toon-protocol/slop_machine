/**
 * The lapse: a slot nobody renewed, taken back out by the hub itself.
 *
 * This is the half of the purchase that makes it a **period rather than a
 * gift**. Without it a broadcaster who stops broadcasting keeps a
 * routing-table entry and keeps a channel the hub has funded collateral into,
 * for ever — which is the problem the whole slot app exists to answer, and
 * the one the buy alone cannot. A hub's capital grows linearly with its
 * roster; nothing shrinks it but this.
 *
 * A ticker walks the roster on an interval and tears down everything past its
 * lapse time. **No request triggers it.** That matters and it is the point of
 * story 17: a teardown that only happened when somebody else bought would
 * leave a hub with one dead station and no new buyers carrying that station
 * for ever, which is precisely the hub that has stopped being able to afford
 * new ones.
 *
 * ## The order, which is the whole design
 *
 * For each lapsed slot, in this order and no other:
 *
 *   1. **every route the slot's peering carries comes out**, one signed
 *      `DELETE /routes/peers/:prefix` each;
 *   2. **then the peering is released**, one signed `DELETE /peers/:id`;
 *   3. **then, and only then, the slot comes off the roster.**
 *
 * Steps 1 and 2 are in that order because the connector enforces it: it
 * refuses to remove a runtime peering while any runtime route still forwards
 * to it (`PeerRouteTableError::PeerInUse`, answered `409 Conflict` — connector
 * ADR 0034's referential rule, the orphaned-row shape its load-time
 * `UnknownPeerId` check exists to prevent, enforced at mutation time). The
 * other order is not a teardown that is merely untidy; it is a teardown that
 * **stops half-way through**, leaving the hub carrying priced addresses toward
 * a station it no longer peers with, and every packet crossing that hop
 * arriving nowhere.
 *
 * Step 3 is last for a different reason. **The roster is the hub's record of
 * what it still has to take back out.** A slot removed from it while its
 * peering survived would be collateral committed toward a counterparty that
 * nothing in this hub remembers — invisible to the next sweep, invisible to
 * a restart, and reclaimable only by a hub operator reading their own
 * connector's tables by hand. So a teardown that failed leaves the slot where
 * it is, says so, and the **next tick tries again**. That is also the invariant
 * boot reconciliation (#39) inherits: a slot on the roster is a claim that the
 * routes and the peering behind it may still exist.
 *
 * ## Why it is a ticker and not a timer per slot
 *
 * One interval walking the whole roster, rather than one `setTimeout` per
 * slot. A roster is bounded by the hub's own cap and read back off disk at
 * boot, so a sweep is a walk over at most a hundred rows and the arithmetic
 * per row is one comparison; a timer per slot would have to be created,
 * cancelled and recreated on every renewal, and a renewal that failed to
 * cancel one would tear down a live slot. The failure mode of a sweep that
 * missed a beat is a slot that lapses a few seconds late. The failure mode of
 * a stale timer is a paying broadcaster taken off the air.
 *
 * ## Time is configuration, not an injected clock
 *
 * Both numbers this module needs are ordinary configuration a hub operator
 * sets — the slot period (`TOON_SLOT_PERIOD_SECONDS`, on the admission
 * policy) and the sweep interval ({@link DEFAULT_LAPSE_SWEEP_SECONDS},
 * `TOON_LAPSE_SWEEP_SECONDS`). The suite sets a period of a second and a
 * sweep of a second, and watches a real slot lapse in real time. That is the
 * precedent `--ingest-idle-seconds` set on the station side, where a time
 * rule was made ordinary configuration instead of an injected clock: no fake
 * timers, no injected `now`, and the thing the test exercises is the thing a
 * hub runs.
 *
 * **The first sweep is one interval after boot, never at boot.** Tearing down
 * at boot is a different job with different rules — it has to reconcile
 * against what the connector actually holds, not only against what the roster
 * says — and it belongs to #39. A ticker that swept immediately would do half
 * of that job blind, before the reconciliation that is supposed to precede it.
 *
 * @module
 */

import { releasePeering } from '../peering/peering.js';
import { withdrawForwardedRoutes } from '../peering/routes.js';
import type { ForwardedRouteDependencies } from '../peering/routes.js';
import { grantedPrefix } from '../slot/handle.js';
import type { SlotRoster } from '../slot/roster.js';

/**
 * How often the hub walks its roster looking for lapsed slots, in seconds
 * (env: `TOON_LAPSE_SWEEP_SECONDS`).
 *
 * A minute. It is the granularity of the lapse, not its length: a slot lasts
 * `TOON_SLOT_PERIOD_SECONDS` and is torn down within one sweep of that, so
 * against a thirty-day period a minute is a rounding error, and against the
 * seconds-long period the suite configures a sweep of seconds is what makes
 * the rule observable. Seconds rather than minutes for exactly that reason —
 * the unit has to reach the values a test needs without becoming a special
 * case.
 *
 * There is deliberately **no value that disables the sweep**. A zero would
 * not be a hub with a longer fuse, it would be a hub that never reclaims
 * anything and whose collateral only ever grows — the bug this module exists
 * to close, reachable by typo. A hub that wants to sweep rarely writes a big
 * number.
 */
export const DEFAULT_LAPSE_SWEEP_SECONDS = 60;

/** A sweep interval the hub will not run with. */
export class LapseError extends Error {
  override readonly name = 'LapseError';
}

/**
 * Resolve the sweep interval, or refuse naming what was configured.
 *
 * Fail-closed and at boot, before anything binds, exactly as the admission
 * policy and the peering policy are.
 *
 * @throws LapseError naming the setting and the value.
 */
export function resolveLapseSweepSeconds(
  value: number | string | undefined
): number {
  if (value === undefined || value === '') return DEFAULT_LAPSE_SWEEP_SECONDS;

  const resolved = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new LapseError(
      `the lapse sweep interval (TOON_LAPSE_SWEEP_SECONDS) must be a whole number of seconds, and at least 1, not ${JSON.stringify(value)}`
    );
  }
  return resolved;
}

/** The sweep as one line an operator can check at boot. */
export function describeLapseSweep(sweepSeconds: number): string {
  return `unrenewed slots are torn down within ${String(sweepSeconds)}s of lapsing`;
}

/** What the ticker needs to tear a slot down. */
export interface LapseDependencies extends ForwardedRouteDependencies {
  /** The roster it walks, and takes a torn-down slot off. */
  roster: SlotRoster;
  /** The hub's own ILP address — what a granted prefix is built beneath. */
  hubAddress: string;
  /** How often to walk it, in seconds. */
  sweepSeconds: number;
}

/** A running ticker. */
export interface LapseTicker {
  /**
   * Stop it, and stop it for good. Idempotent.
   *
   * A sweep already in flight is left to finish its current teardown rather
   * than abandoned mid-way: the writes it makes are each individually safe to
   * repeat, but a process that stopped between the routes and the peering
   * would leave a peering that a `409` will refuse until the routes are gone,
   * and the next boot would have to work that out. What `stop` guarantees is
   * that **no further sweep starts**.
   */
  stop(): void;
  /**
   * Walk the roster once, right now, and resolve when the walk is done.
   *
   * The same walk the interval makes, exposed so a caller with a reason to
   * sweep at a moment of its own choosing — a test, or the boot
   * reconciliation to come — does not have to wait for a tick or reach into
   * this module for the pieces.
   *
   * @returns the labels of the slots torn down, in the order they went.
   */
  sweep(): Promise<string[]>;
}

/**
 * Start the ticker.
 *
 * The first sweep happens one interval from now, not immediately — see this
 * module's header. The timer is **unref'd**: reclaiming collateral is
 * bookkeeping the hub does while it is up, not work that should hold a
 * process open, and a node with nothing else to do should exit rather than
 * live on because a sweep is pending. That is also what keeps a suite from
 * hanging on an open handle.
 *
 * Sweeps never overlap. A sweep that is still working when the next tick
 * arrives means the hub's own operator surface is slow, and stacking a second
 * walk over the first would have both of them tearing down the same slot at
 * once: the removals are idempotent, so it would not corrupt anything, but it
 * would double the load on exactly the surface that is already struggling.
 */
export function startLapseTicker(deps: LapseDependencies): LapseTicker {
  let stopped = false;
  let sweeping = false;

  async function sweep(): Promise<string[]> {
    const now = Date.now();
    const lapsed = deps.roster.held().filter((slot) => slot.lapsesAt <= now);
    const torn: string[] = [];

    for (const slot of lapsed) {
      // Each slot on its own. A teardown that fails is one slot the hub still
      // holds, not a sweep that gives up on the rest of them — the roster's
      // other rows are other broadcasters, and one unreachable station must
      // not keep the hub carrying the rest of its dead ones.
      if (await tearDown(deps, slot.payer, slot.label)) torn.push(slot.label);
    }

    return torn;
  }

  const timer = setInterval(() => {
    if (stopped || sweeping) return;
    sweeping = true;
    void sweep().finally(() => {
      sweeping = false;
    });
  }, deps.sweepSeconds * 1000);

  // A sweep is bookkeeping, not work the node should stay alive for.
  timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    sweep,
  };
}

/**
 * Tear one slot down: routes, then peering, then the roster row.
 *
 * @returns `true` where the slot is gone, `false` where it is still held and
 * the next sweep will try again. Never throws — a sweep has no caller to
 * answer, so a failure is a log line and a slot left standing, which is the
 * safe direction: the hub goes on remembering something it still has to
 * reclaim.
 */
async function tearDown(
  deps: LapseDependencies,
  payer: string,
  label: string
): Promise<boolean> {
  const prefix = grantedPrefix(deps.hubAddress, label);

  let removed: string[];
  try {
    // 1. The routes, all of them — every row beneath the granted prefix and
    //    every row forwarding to this peering's label. The peering cannot go
    //    while one of them stands.
    removed = await withdrawForwardedRoutes(deps, {
      grantedPrefix: prefix,
      localLabel: label,
    });
  } catch (error) {
    console.error(
      `[slot-app] the slot at ${prefix} has lapsed and its routes could not be taken out, so it is still held and the next sweep will try again: ${said(error)}`
    );
    return false;
  }

  try {
    // 2. The peering, now that nothing forwards to it. This is the write that
    //    stops the carriage — and it is NOT the write that brings the
    //    collateral back: the deposit stays in the channel until somebody
    //    closes and settles it, which nothing in this app does. See ADR
    //    0003's third amendment.
    await releasePeering(deps, { localLabel: label });
  } catch (error) {
    console.error(
      `[slot-app] the slot at ${prefix} has lapsed and its ${String(removed.length)} route(s) are out, but the peering could not be released, so it is still held and the next sweep will try again: ${said(error)}`
    );
    return false;
  }

  try {
    // 3. The roster row, last. Until this lands the hub is still claiming it
    //    has work to do here, which is exactly the claim that makes a failed
    //    teardown recoverable rather than forgotten.
    await deps.roster.remove(payer);
  } catch (error) {
    console.error(
      `[slot-app] the slot at ${prefix} was torn down and could not be taken off the roster; the hub's own data directory is the thing to fix: ${said(error)}`
    );
    return false;
  }

  console.log(
    `[slot-app] slot at ${prefix} lapsed: ${String(removed.length)} route(s) removed${removed.length === 0 ? '' : ` (${removed.join(', ')})`}, peering ${label} released, slot taken off the roster`
  );
  return true;
}

function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
