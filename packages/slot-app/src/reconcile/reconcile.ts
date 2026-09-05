/**
 * Boot reconciliation: the roster and the hub's routing table, made to agree.
 *
 * They are two records of one fact — this broadcaster is reachable here until
 * then — kept in two places because they have to be. The roster is the hub's
 * own durable record of what it sold; the connector's tables are what it is
 * actually carrying. A crash between two writes leaves them disagreeing, and
 * so does a hub operator editing their own table by hand. Nothing else in this
 * app ever notices: the buy writes what the purchase says, and the lapse
 * removes what the roster says, and neither of them asks whether the two agree.
 * So this runs once, at boot, before the app takes a request.
 *
 * ## The order, and why it is that order
 *
 *   1. **Read** the connector's own peerings and routes, over the bearer-gated
 *      read surface. Nothing is decided from the roster alone: a hub that
 *      wrote blind would rewrite rows already there and delete rows it had
 *      merely failed to read.
 *   2. **Tear down what lapsed while the process was down** — the lapse's own
 *      teardown, unchanged: every route out first, then the peering released,
 *      then the roster row. **Downtime must not extend anybody's slot.** The
 *      ticker deliberately makes its first sweep one interval *after* boot, so
 *      that the tearing-down of what was already lapsed happens here, with the
 *      connector's tables in hand, rather than blind at the first tick.
 *   3. **Write back what a live slot is missing.** A slot with time left on it
 *      is a promise the hub took money for; a row of it missing from the
 *      connector is a broadcaster who is paid up and unreachable. The peering
 *      is re-established first where it is gone (a route cannot forward to a
 *      peering the table does not hold) **and the hub's collateral put behind
 *      the channel that write names** — a re-established peering may have
 *      opened a fresh one, and a route pointed at an empty channel is an
 *      address that is reachable, paid for and answers `T00` — then each
 *      address the purchase granted that the table is missing, or holds
 *      pointing at the wrong peering, or holds at the wrong price.
 *   4. **Take out what the roster does not hold.** A peering or a route the
 *      connector carries for a slot nobody holds is collateral committed and
 *      an address served toward a station that bought neither. Removed in the
 *      same order and by the same fenced code path a lapse uses — routes
 *      first, then the peering — because it is the same act: tearing down a
 *      slot, one that is not on the roster because a crash landed between the
 *      peering write and the roster write.
 *
 * ## The fence, which matters more here than anywhere else in the app
 *
 * Step 4 is a **destructive write against a table every broadcaster on the hub
 * shares, and that the hub operator writes to by hand as well.** "The
 * connector holds what the roster does not" is, read literally, an instruction
 * to delete the operator's own rows. So it is fenced three times, and each
 * fence is independent of the others:
 *
 *   - **Source.** Only a row the connector itself reports as `runtime` is ever
 *     a candidate. A `config` row is the hub operator's file's, and a runtime
 *     row never shadows one. The connector would answer `409` — but this app
 *     does not ask, because a fence that consists of being refused is not a
 *     fence, and the day a connector answers something else it would be a
 *     deletion.
 *   - **Shape.** Only a label this hub could itself have derived — see
 *     `../slot/handle.ts` — and only a prefix inside the address space that
 *     label is granted. `g.hub.abcdef012345.now` is in; `g.hub.demo`, the
 *     placeholder a hub operator reserves for themselves, is not, and neither
 *     is a hand-written peering called `apex-relay`. The app cleans up after
 *     itself and after nobody else.
 *   - **The roster.** Only a label no live slot holds. That is the actual
 *     question being asked, and it is asked last, of a roster that has already
 *     had step 2's lapses taken off it.
 *
 * And then the removal itself goes through `withdrawForwardedRoutes`, whose
 * own choke point re-checks ownership per row — the same double proof the
 * lapse and the renewal use, rather than a fourth spelling of it here.
 *
 * ## It never throws, and a hub with an unreachable connector still boots
 *
 * Reconciliation is bookkeeping, not a precondition. A hub whose connector is
 * still coming up cannot read its tables, and refusing to boot over that would
 * turn a slow start into an outage — while a hub that boots without it loses
 * nothing permanently: the ticker still lapses what is past its time within a
 * sweep, a renewal still rewrites its own rows, and the next boot reconciles.
 * So every failure here is a log line an operator can act on and a hub that
 * came up.
 *
 * @module
 */

import { fundChannel } from '../peering/collateral.js';
import { establishPeering, releasePeering } from '../peering/peering.js';
import type { PeeringReadDependencies } from '../peering/peering.js';
import { readCarriedPeerings } from '../peering/peering.js';
import {
  readCarriedRoutes,
  withdrawForwardedRoutes,
  writeForwardedRoutes,
} from '../peering/routes.js';
import type { CarriedRoute, ForwardedRoute } from '../peering/routes.js';
import {
  grantedLabelIn,
  grantedPrefix,
  isHandleLabel,
} from '../slot/handle.js';
import type { GrantedRoute, Slot, SlotRoster } from '../slot/roster.js';

/** What reconciling at boot needs. */
export interface ReconcileDependencies extends PeeringReadDependencies {
  /**
   * The hub's peering policy — and, unlike the two writes it extends, **what
   * the hub fronts per peering** as well.
   *
   * Establishing a peering and releasing one need neither the collateral nor
   * a way to reach the channel behind it; a boot that re-establishes one does,
   * because a route written back toward an empty channel is an address that is
   * reachable, paid for and dead.
   */
  policy: PeeringReadDependencies['policy'] & { collateral: number };
  /** The roster, read back off the data directory a moment ago. */
  roster: SlotRoster;
  /** The hub's own ILP address — what a granted prefix is built beneath. */
  hubAddress: string;
  /**
   * Tear down everything already past its lapse time, and answer with the
   * labels that went.
   *
   * This is the lapse ticker's own sweep, handed in rather than reimplemented:
   * tearing a slot down at boot and tearing one down at a tick are the same
   * act, and a second implementation of it would be a second chance to get the
   * order — routes, then the peering, then the roster row — wrong.
   */
  sweep(): Promise<string[]>;
}

/** What one boot's reconciliation did, for the log line and for a caller. */
export interface Reconciled {
  /** Labels torn down because their slot had lapsed while the hub was down. */
  lapsed: string[];
  /** Prefixes written back because the connector was not carrying them. */
  written: string[];
  /** Prefixes taken out because no slot on the roster had bought them. */
  removed: string[];
  /** Labels whose peering was released because no slot on the roster held it. */
  released: string[];
}

/**
 * Make the connector's tables and the roster agree, once, at boot.
 *
 * Resolves when there is nothing further to do — including when nothing could
 * be done, which is logged rather than thrown. See this module's header for
 * the order and for the three fences on the removals.
 */
export async function reconcileAtBoot(
  deps: ReconcileDependencies
): Promise<Reconciled> {
  const done: Reconciled = {
    lapsed: [],
    written: [],
    removed: [],
    released: [],
  };

  // 1. What the hub is actually carrying. Read before anything is decided,
  //    and the one thing here that is allowed to end the whole attempt: a
  //    table that could not be read is a table nothing may be concluded from.
  let carried: { peerings: string[]; routes: CarriedRoute[] };
  try {
    carried = await readTables(deps);
  } catch (error) {
    console.error(
      `[slot-app] the hub's own connector could not be read at boot, so its routing table and this roster were not reconciled; the sweep will still take out what has lapsed, and the next boot will try again: ${said(error)}`
    );
    return done;
  }

  // 2. What lapsed while the process was down, torn down now rather than at
  //    the first tick. Downtime must not extend anybody's slot.
  try {
    done.lapsed = await deps.sweep();
  } catch (error) {
    // The sweep already swallows a per-slot failure; reaching here is the
    // roster or the surface failing wholesale, and the ticker will try again.
    console.error(
      `[slot-app] tearing down what lapsed while this hub was down did not finish; the next sweep will try again: ${said(error)}`
    );
  }
  if (done.lapsed.length > 0) {
    // The tables moved under us. Re-read rather than reason about a snapshot
    // taken before rows were removed from it.
    try {
      carried = await readTables(deps);
    } catch (error) {
      console.error(
        `[slot-app] the hub's own connector could not be re-read after the boot teardown; the rest of the reconciliation is left to the next boot: ${said(error)}`
      );
      return done;
    }
  }

  const live = deps.roster.held();

  // 3. What a live slot bought and the hub is not carrying.
  for (const slot of live) {
    try {
      done.written.push(...(await restore(deps, slot, carried)));
    } catch (error) {
      console.error(
        `[slot-app] the slot at ${grantedPrefix(deps.hubAddress, slot.label)} is missing rows on this hub's own connector and they could not be written back, so that broadcaster is paid up and not fully reachable; a renewal rewrites them, and the next boot will try again: ${said(error)}`
      );
    }
  }

  // 4. What the hub is carrying for nobody. Fenced by source, by shape and by
  //    the roster — see this module's header — and removed through the same
  //    path a lapse removes by.
  const held = new Set(live.map((slot) => slot.label));
  for (const label of orphans(deps.hubAddress, carried, held)) {
    try {
      const removed = await withdrawForwardedRoutes(deps, {
        grantedPrefix: grantedPrefix(deps.hubAddress, label),
        localLabel: label,
      });
      done.removed.push(...removed);
      await releasePeering(deps, { localLabel: label });
      done.released.push(label);
      console.log(
        `[slot-app] this hub was carrying ${String(removed.length)} route(s) and a peering for ${label}, which no slot on its roster holds; taken back out`
      );
    } catch (error) {
      console.error(
        `[slot-app] this hub is carrying rows for ${label}, which no slot on its roster holds, and they could not be taken back out; the next boot will try again: ${said(error)}`
      );
    }
  }

  console.log(
    `[slot-app] reconciled at boot: ${String(done.lapsed.length)} slot(s) lapsed while down and torn out, ${String(done.written.length)} route(s) written back, ${String(done.removed.length)} route(s) and ${String(done.released.length)} peering(s) removed for slots nobody holds`
  );

  return done;
}

/** Both of the connector's own tables, read once. */
async function readTables(
  deps: ReconcileDependencies
): Promise<{ peerings: string[]; routes: CarriedRoute[] }> {
  const peerings = await readCarriedPeerings(deps);
  const routes = await readCarriedRoutes(deps);
  return {
    // Runtime rows only, from here on. A config row is the hub operator's and
    // is neither this app's to remove nor a row it may write over.
    peerings: peerings
      .filter((peering) => peering.source === 'runtime')
      .map((peering) => peering.localLabel),
    routes: routes.filter((route) => route.source === 'runtime'),
  };
}

/**
 * Write back whatever this slot bought that the hub is not carrying.
 *
 * A slot recorded before this app kept the terms of a purchase has nothing to
 * write back from; it is left exactly as it is, and its next renewal — which
 * re-reads the broadcaster's own connector — records them. Guessing at a
 * station's addresses would be the one thing worse than leaving them alone.
 *
 * @returns the prefixes written back.
 */
async function restore(
  deps: ReconcileDependencies,
  slot: Slot,
  carried: { peerings: string[]; routes: CarriedRoute[] }
): Promise<string[]> {
  const granted = slot.routes;
  if (granted === undefined || slot.stationUrl === undefined) {
    console.warn(
      `[slot-app] the roster does not record what the slot at ${grantedPrefix(deps.hubAddress, slot.label)} was granted, so this hub cannot tell whether it is still carrying it; the next renewal records it`
    );
    return [];
  }

  const peered = carried.peerings.includes(slot.label);
  const missing = granted.filter(
    (route) => !matched(carried.routes, slot, route)
  );
  if (peered && missing.length === 0) return [];

  if (!peered) {
    // A route cannot forward to a peering the table does not hold, so this
    // comes first — the same ordering the buy uses, for the same reason. The
    // write is an upsert: where the peering IS there and only its routes are
    // missing, this is not reached at all, so a healthy boot opens no channel
    // and spends no gas.
    const peering = await establishPeering(deps, {
      localLabel: slot.label,
      stationUrl: slot.stationUrl,
      chain: slot.chain,
    });
    // And the collateral behind it, before any route is written back — the
    // buy's own rule, on the only other path in this app that establishes a
    // peering. A re-established peering may have opened a fresh channel, and
    // a route pointed at an empty one is an address that is reachable, paid
    // for and answers `T00`. The deposit is a shortfall against what the
    // channel already holds, so a peering that was re-established over the
    // channel it always had is funded with nothing at all.
    const funded = await fundChannel(deps, { channelId: peering.channel.id });
    console.log(
      `[slot-app] the slot at ${grantedPrefix(deps.hubAddress, slot.label)} has time left on it and this hub was not peered with it; re-established, channel holding ${funded.held.toString()}${funded.deposited === 0n ? ' already' : `, ${funded.deposited.toString()} of it deposited now`}`
    );
  }

  if (missing.length === 0) return [];

  await writeForwardedRoutes(deps, {
    localLabel: slot.label,
    routes: missing.map(forwarded),
  });
  console.log(
    `[slot-app] the slot at ${grantedPrefix(deps.hubAddress, slot.label)} has time left on it and this hub was not carrying ${missing.map((route) => route.prefix).join(', ')}; written back`
  );
  return missing.map((route) => route.prefix);
}

/**
 * Whether the hub is already carrying this granted address, as granted.
 *
 * Three things have to agree, and a row that gets any of them wrong is
 * rewritten rather than left: the prefix has to be there at all; it has to
 * forward to *this* slot's peering, since one pointing anywhere else is a
 * packet arriving at somebody else's station; and it has to be priced at what
 * the purchase granted, since a row priced under the station's own termination
 * is an address that is reachable, paid for and dead (connector ADR 0029).
 */
function matched(
  carried: readonly CarriedRoute[],
  slot: Slot,
  granted: GrantedRoute
): boolean {
  const row = carried.find((candidate) => candidate.prefix === granted.prefix);
  if (row === undefined) return false;
  if (row.peerId !== slot.label) return false;
  return row.price === undefined || samePrice(row.price, granted);
}

/**
 * Whether a price read back off the hub's table is the one it was granted at.
 *
 * A number too large to have survived JSON intact is treated as agreeing. A
 * price is a `u64` of base units and a double cannot hold all of them, so a
 * comparison against a rounded one would disagree with a row that is in fact
 * correct — and disagree again on every boot after this one.
 */
function samePrice(
  carried: NonNullable<CarriedRoute['price']>,
  granted: GrantedRoute
): boolean {
  const perKib = granted.pricePerKib ?? '0';
  if (typeof carried === 'number') {
    if (!Number.isSafeInteger(carried)) return true;
    return String(carried) === granted.price && perKib === '0';
  }
  if (!Number.isSafeInteger(carried.base)) return true;
  return (
    String(carried.base) === granted.price && String(carried.per_kib) === perKib
  );
}

/** A granted address, as the write side takes one. */
function forwarded(granted: GrantedRoute): ForwardedRoute {
  return {
    prefix: granted.prefix,
    // What the station itself charges is not recorded, and is not needed to
    // rewrite the row: what was granted is the hub's own price, and the
    // arithmetic that produced it was done once, at the purchase.
    stationPrice: 0n,
    price: BigInt(granted.price),
    pricePerKib: BigInt(granted.pricePerKib ?? '0'),
  };
}

/**
 * The labels this hub is carrying rows for that no live slot holds.
 *
 * Every fence in this module's header is applied here, and only rows passing
 * all of them become a label at all. A row is claimed by a label two ways —
 * by sitting inside the address space that label is granted, or by forwarding
 * to that label's own peering — because the connector's referential rule is
 * keyed on the label while a grant is keyed on the prefix, and a teardown has
 * to satisfy the first while staying inside the second.
 */
function orphans(
  hubAddress: string,
  carried: { peerings: string[]; routes: CarriedRoute[] },
  held: ReadonlySet<string>
): string[] {
  const labels = new Set<string>();

  for (const label of carried.peerings) {
    if (isHandleLabel(label) && !held.has(label)) labels.add(label);
  }

  for (const route of carried.routes) {
    const byPrefix = grantedLabelIn(hubAddress, route.prefix);
    if (byPrefix !== undefined && !held.has(byPrefix)) labels.add(byPrefix);
    if (isHandleLabel(route.peerId) && !held.has(route.peerId)) {
      labels.add(route.peerId);
    }
  }

  return [...labels];
}

function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
