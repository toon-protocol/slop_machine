/**
 * The station's *now*: where the live edge is, right this moment.
 *
 * ```
 * GET /now
 * ```
 *
 * A station is a continuous broadcast and a viber joining one already in
 * progress wants what everyone else on it is receiving — not sequence zero,
 * which may be an hour old and, once retention lands, may not exist any more.
 * So one cheap address per station reports the whole of what a viber needs to
 * start pulling: **every rung's current sequence number**, the **fixed segment
 * duration**, and **whether ingest is live**.
 *
 * Three things follow from those three fields, and each is why one of them is
 * there:
 *
 *   - A viber pulls *now*, then pulls `sequence` at the rung their budget can
 *     afford, and is at the live edge — one paid request instead of walking
 *     forward from zero.
 *   - Every rung's sequence is reported in the same answer, so a player that
 *     wants the same span one rung up or down already knows its number. That
 *     is what makes climbing and dropping rungs mid-broadcast a choice about
 *     price rather than a re-sync.
 *   - `live` tells a **stalled edge apart from a station that ended**. A
 *     sequence that stopped advancing means nothing on its own; the same
 *     sequence with `live: false` is a broadcaster who dropped, and with
 *     `live: true` an encoder falling behind.
 *
 * **One station has one *now*.** The answer is read from the segmenter's own
 * view of what it has finished, so two vibers asking at the same moment see
 * the same edge. Nothing here is per-viber and nothing is negotiated.
 *
 * **This is a paid address, and it sits under its own prefix.** `/now` is
 * outside `/segments` entirely and outside every rung's prefix, so the
 * connector in front terminates one route on it at its own low price — a
 * viber re-syncing must not be charged a segment's price, and a segment must
 * never be reachable at this address's price. It is deliberately *not*
 * `/health`: liveness is unpriced in-node process liveness, answered whether
 * or not a broadcaster is publishing, and it is not the same question.
 *
 * **No payment code lives here.** Nothing reads a payment header, requires
 * one, or echoes one back.
 *
 * **No playlist is served, here or anywhere on a station.** This report is the
 * whole of the origin's discovery surface: it carries sequence numbers and a
 * duration, not URIs, and it is not HLS-shaped. The client daemon already
 * stands between the station and the player and synthesizes whatever playlist
 * its player wants over loopback. Serving one here would double the paid
 * requests per cycle and buy nothing. A station's rungs and their *prices* are
 * learned from the announcement carried by a hub's relay, which is why no
 * price appears in this answer.
 *
 * @module
 */

import { Hono } from 'hono';
import type { SegmenterInstance } from '../segmenter/segmenter.js';

/**
 * The prefix the station's *now* sits beneath — and, being the whole address,
 * is.
 *
 * This is what a connector route in front is written against, at its own low
 * price. It is one level up from nothing: no other address lives beneath it,
 * which is exactly the property that lets it be priced on its own without
 * dragging a segment's price along with it.
 */
export const NOW_ROUTE_PREFIX = '/now';

/** What the *now* report is, on the wire. */
export const NOW_CONTENT_TYPE = 'application/json';

/** Where one rung's live edge is. */
export interface RungNow {
  /**
   * The rung's name — the same one that appears in its address,
   * `/segments/<rung>/<sequence>.ts`.
   */
  rung: string;
  /**
   * The newest sequence number this station is holding at that rung, or
   * `null` when it holds none yet.
   *
   * `null` is a station that has not finished a segment at this rung — a
   * broadcaster who has not gone live yet, or one whose first span is still
   * encoding. It is deliberately not `0`, which is a real, pullable segment
   * and would send a viber to buy vibes that do not exist.
   */
  sequence: number | null;
}

/**
 * The station's *now*, as a viber reads it.
 *
 * Sequence numbers only: no URIs, no playlist, no prices. A viber builds the
 * address itself — the shape is fixed — and learns what a rung costs from the
 * announcement a hub's relay carries, never from the origin.
 */
export interface StationNow {
  /**
   * Whether a broadcaster is publishing **right now**.
   *
   * True from the moment a publish is accepted until the moment that session
   * ends, and it is the plain fact of an open ingest rather than a guess from
   * how recently a segment appeared. That is what makes it usable as the
   * signal a reconnecting broadcaster is watched through: a station whose
   * sequences have stopped advancing is stalled while this is true and ended
   * while it is false.
   */
  live: boolean;
  /**
   * The fixed duration every segment covers, in seconds.
   *
   * Reported because it is what turns a sequence number into a time: a viber
   * pacing its pulls, or deciding how far behind the edge it is willing to
   * sit, needs it, and it is fixed precisely so that a flat per-segment price
   * is honestly a per-second rate.
   */
  segmentSeconds: number;
  /**
   * Every rung this station offers, in ladder order — cheapest first — with
   * where each one's live edge is.
   *
   * All of them in one answer, because a player choosing a rung on a budget is
   * choosing between prices for the same span and needs the alternatives'
   * numbers before it can climb or drop. An array rather than an object
   * because the order is the ladder, and the ladder is meaningful.
   */
  rungs: RungNow[];
}

/** What the *now* route needs to answer. */
export interface NowDependencies {
  /** The station's segmenter, which knows what it has finished at each rung. */
  segmenter: SegmenterInstance;
  /** Whether a broadcaster is publishing right now. */
  isLive: () => boolean;
}

/**
 * The route that reports the station's *now*, to be mounted at
 * {@link NOW_ROUTE_PREFIX}.
 *
 * Always `200`. A station with no ingest is still a station: it answers,
 * reports `live: false` and a `sequence` of `null` at every rung it offers,
 * and says so at exactly the same address rather than by going missing. A
 * viber cannot tell a refusal from a station that ended, and both of those are
 * things it must be able to act on.
 */
export function nowRoutes(deps: NowDependencies): Hono {
  const routes = new Hono();

  routes.get('/', (c) => {
    // Read in one pass, from the segmenter's own index. Every rung the ladder
    // has is reported, in ladder order, whether or not it has produced
    // anything yet — the list of rungs is configuration, not a consequence of
    // what happened to encode.
    const now: StationNow = {
      live: deps.isLive(),
      segmentSeconds: deps.segmenter.segmentSeconds,
      rungs: deps.segmenter.rungs.map((rung) => ({
        rung: rung.name,
        sequence: deps.segmenter.latest(rung.name)?.sequence ?? null,
      })),
    };

    return c.json(now, 200, {
      // The edge moves every segment, and this answer was paid for by whoever
      // asked. A cache handing a stale edge to the next viber would send them
      // to buy vibes that have already passed — and hand away the payment for
      // asking.
      'cache-control': 'no-store',
    });
  });

  return routes;
}
