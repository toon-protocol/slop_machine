/**
 * The viber's machinery, shared between the demo and the remote viewer.
 *
 * `demo.ts` grew this first: the ledger a page renders from, the one-at-a-time
 * queue every paid send goes through, and the cycle that buys the station's
 * *now* and then every span between where this viber got to and where the
 * live edge is. `viewer.ts` walks exactly the same loop from another machine,
 * and a second copy of "how a viber buys a broadcast" would drift silently —
 * both callers still green, against two different ideas of what a pull is. So
 * there is one implementation and both call it.
 *
 * NOTHING HERE HOLDS A VALUE OF ITS OWN — the same rule as `paid.ts`, for the
 * same reason: the prefixes, the prices, the preroll and the window stay with
 * the caller.
 */

import { pullThroughTheHub } from './paid.js';
import type { Payer } from './payer.js';
import type { StationNow } from './vibes.js';

/** What one rung costs, and how that splits at the two nodes' own prices. */
export interface RungPrices {
  /** What a viber pays for one segment at this rung, across the hop. */
  price: bigint;
  /** What the station charges to terminate it. */
  toStation: bigint;
  /** What the hub keeps for carrying it. */
  toHub: bigint;
}

/**
 * What the viber has spent, and how it split.
 *
 * `toStation` and `toHub` are DERIVED FROM PRICES THE CALLER LEARNED from the
 * two nodes rather than from a fee this file knows: the station publishes
 * what it charges to terminate, the hub prices what it carries, and the
 * difference is the hub's. A loop that hard-coded 20 would be showing its own
 * arithmetic.
 */
export interface Ledger {
  spent: bigint;
  toStation: bigint;
  toHub: bigint;
  packets: number;
  perRung: Map<string, { bought: number; spent: bigint }>;
}

/** A fresh ledger, with a per-rung row for each rung of the ladder. */
export function createLedger(ladder: string[]): Ledger {
  return {
    spent: 0n,
    toStation: 0n,
    toHub: 0n,
    packets: 0,
    perRung: new Map(ladder.map((rung) => [rung, { bought: 0, spent: 0n }])),
  };
}

/** One paid answer into the ledger, split at the caller's own prices. */
export function recordSpend(
  ledger: Ledger,
  prices: Map<string, RungPrices>,
  rung: string,
  paid: bigint
): void {
  const split = prices.get(rung);
  ledger.spent += paid;
  ledger.packets += 1;
  if (split !== undefined) {
    ledger.toStation += split.toStation;
    ledger.toHub += paid - split.toStation;
  }
  const held = ledger.perRung.get(rung);
  if (held !== undefined) {
    held.bought += 1;
    held.spent += paid;
  }
}

/**
 * Every paid send goes through one of these, one at a time.
 *
 * A claim strictly advances a nonce the connector has already banked, so two
 * pulls signing at once is two claims racing for one number — and the loser
 * is refused for a reason that has nothing to do with the caller.
 */
export function createSerially(): <T>(work: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };
}

/**
 * Retry one step of a run, when the way to the hub is a circuit.
 *
 * The Anyone network is a LIVE third-party network: a circuit that carried
 * the last packet can fail to carry the next one, and the client's transport
 * is deliberately one-shot. With `enabled` false this is exactly one attempt
 * — the loopback demo behaves as it always has — and over the circuit a
 * transient gets a few more tries before it is believed. Wrap only steps that
 * are safe to repeat: a quote is just a quote, the buy is retry-safe by the
 * slot app's own design (a repeat finds the peering rather than opening a
 * second channel), and an announcement write is an upsert of the
 * broadcaster's own events.
 */
export async function withCircuitPatience<T>(
  enabled: boolean,
  what: string,
  report: (line: string) => void,
  work: () => Promise<T>
): Promise<T> {
  const attempts = enabled ? 4 : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (cause) {
      if (attempt >= attempts) throw cause;
      report(
        `${what} did not land (attempt ${String(attempt)} of ${String(attempts)}): ${cause instanceof Error ? cause.message : String(cause)} — the circuit is a live network; retrying`
      );
      await new Promise((waited) => setTimeout(waited, 10_000));
    }
  }
}

export interface ViberCycleOptions {
  /** The party paying, with its one open channel toward the hub. */
  viber: Payer;
  /** The station connector's edge identity, which every pull is sealed to. */
  sealTo: string;
  /** The station's granted prefix — what `.now` and every rung sit beneath. */
  stationPrefix: string;
  /** The rungs to buy, cheapest first. */
  ladder: string[];
  /**
   * How far behind the live edge a viber starts buying. Not at the edge
   * itself: a player with one segment in hand has nothing to play while the
   * next one is being paid for, and stalls between every span.
   */
  prerollSegments: number;
  /**
   * And how far behind it is allowed to fall before it gives up and jumps. A
   * viber that has drifted past this is buying vibes that are about to be
   * evicted underneath them, so it skips forward — which is what a live
   * player does, and the playlist says so with a discontinuity.
   */
  maxSegmentsBehind: number;
  /** The caller's ledger, advanced by every paid answer. */
  ledger: Ledger;
  /** What each address costs and how it splits, learned by the caller. */
  prices: Map<string, RungPrices>;
  /** The contract's own switch: nothing is bought while this is false. */
  vibing: () => boolean;
  /** The caller's stop flag; a cycle returns early once it is set. */
  stopping: () => boolean;
  /** Every fresh *now*, as it lands — the caller's page reads the live edge off it. */
  onEdge: (edge: StationNow) => void;
  /** One bought segment, into the caller's window. */
  publish: (rung: string, sequence: number, body: Uint8Array) => void;
  /** A sequence that was paid for and was not vibes, or a jump — the playlist skips it. */
  missed: (rung: string) => void;
}

/**
 * The cycle: one *now* per call, paid for like everything else, and then
 * every span between where this viber got to and where the live edge is.
 * There is no free call in here — `/now` is a priced address of the station's
 * precisely so that finding the live edge is not the one thing a station
 * gives away.
 */
export function createViberCycle(
  options: ViberCycleOptions
): () => Promise<void> {
  const serially = createSerially();
  const cursor = new Map<string, number>();

  return async (): Promise<void> => {
    // The contract's own switch: a guide that POSTed /contract/v1/stop has
    // stopped the spend, and nothing is bought until it vibes again.
    if (!options.vibing()) return;

    const answer = await serially(() =>
      pullThroughTheHub(
        options.viber,
        options.sealTo,
        `${options.stationPrefix}.now`
      )
    );
    recordSpend(options.ledger, options.prices, 'now', answer.paid);
    if (answer.status !== 200) return;

    const edge = JSON.parse(answer.text) as StationNow;
    options.onEdge(edge);

    for (const rung of options.ladder) {
      const latest = edge.rungs.find((held) => held.rung === rung)?.sequence;
      if (latest === null || latest === undefined) continue;

      let at = cursor.get(rung);
      if (at === undefined) at = Math.max(0, latest - options.prerollSegments);
      // Fallen behind the station's own window: the vibes in between are
      // being evicted underneath us, so skip to where they still exist.
      if (latest - at > options.maxSegmentsBehind) {
        at = latest - options.prerollSegments;
        options.missed(rung);
      }

      for (; at <= latest; at += 1) {
        if (options.stopping()) return;
        // Bound to a const before it is handed to the queue. `serially` runs
        // its closure later than it is written, and a closure over the loop
        // variable would pay for whichever sequence the loop had reached by
        // then rather than the one it meant to buy.
        const wanted = at;
        const segment = await serially(() =>
          pullThroughTheHub(
            options.viber,
            options.sealTo,
            `${options.stationPrefix}.${rung}`,
            `${String(wanted)}.ts`
          )
        );
        recordSpend(options.ledger, options.prices, rung, segment.paid);

        // A 404 rode home on a FULFILL and cost exactly what a 200 costs —
        // that is what a paid answer is. It is simply not vibes.
        if (segment.status === 200) {
          options.publish(rung, wanted, segment.body);
        } else {
          options.missed(rung);
        }
      }
      cursor.set(rung, at);
    }
  };
}
