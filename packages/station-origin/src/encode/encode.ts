/**
 * The encode report: is this box big enough for the ladder it was given?
 *
 * ```
 * GET /encode
 * ```
 *
 * A broadcaster whose station stutters has two suspects — *my ladder is too
 * ambitious for this hardware* and *my uplink is bad* — and from the outside
 * they are indistinguishable. This address is the difference. It reports, per
 * rung, whether the encode is keeping pace with ingest, measured against the
 * clock and the segments that have actually finished, plus what those segments
 * actually weighed.
 *
 * **It is broadcaster-facing, and it sits where liveness sits.** Alongside
 * `/health`, outside every prefix the connector routes, on the segment port —
 * which is published on no interface. So it is reachable from inside the node
 * and from nowhere else, it costs nothing, and it is not a new free door on a
 * station: nothing free is served *from* a station, and nothing here is.
 *
 * **It is deliberately not the station's *now*.** `/now` is viber-facing, paid,
 * and about the live edge: which sequence to pull next. This is
 * operator-facing, unpriced, and about the box: whether the encoder is losing
 * ground. They answer different questions for different people, they are
 * priced differently (one of them at all), and neither carries the other's
 * fields — no sequence numbers appear here.
 *
 * **No payment code lives here.** Nothing reads a payment header, requires
 * one, or echoes one back. There is no payment code anywhere in this repo.
 *
 * What makes the answer actionable is that it is **per rung**. One ingest is
 * encoded at every rung at once, so a cheap rung keeping pace while an
 * expensive one falls behind names the rung to drop. Every rung behind at once,
 * with `live` true, is the same verdict about the whole ladder. And an edge
 * that stopped moving while nothing is behind is not the encode at all — that
 * is `live` going false, which is the uplink.
 *
 * @module
 */

import { Hono } from 'hono';
import type { SegmenterInstance } from '../segmenter/segmenter.js';
import type { RungEncode } from '../segmenter/pace.js';
import { SEGMENT_BYTE_BUDGET } from '../segmenter/rung.js';

/**
 * The prefix the encode report sits beneath — and, being the whole address, is.
 *
 * It is **not** a connector route and must never become one. Like `/health` it
 * lives outside everything the connector in front terminates, which is what
 * keeps it unpriced without being free to the internet: the segment port is
 * published on no interface.
 */
export const ENCODE_ROUTE_PREFIX = '/encode';

/** What the encode report is, on the wire. */
export const ENCODE_CONTENT_TYPE = 'application/json';

/** How the encode is doing at one rung, as a broadcaster reads it. */
export type RungEncodeReport = RungEncode;

/** The whole encode report. */
export interface EncodeReport {
  /**
   * Whether a broadcaster is publishing right now.
   *
   * Here so the rest of the answer can be read at all: a rung encoding nothing
   * because nobody is broadcasting is not a rung that is behind, and the two
   * are the same picture without this field.
   */
  live: boolean;
  /** The station's fixed segment duration, in seconds. */
  segmentSeconds: number;
  /**
   * The most bytes a segment may be (ADR 0001), so the measured sizes below
   * can be read against it without the reader having to know the number.
   */
  segmentByteBudget: number;
  /**
   * Every rung on the ladder, in ladder order — cheapest first — and how its
   * encode is doing. All of them, always, whether or not any has encoded
   * anything: the ladder is configuration, not a consequence of what happened
   * to encode.
   */
  rungs: RungEncodeReport[];
}

/** What the encode report needs to answer. */
export interface EncodeDependencies {
  /** The station's segmenter, which is what is doing the encoding. */
  segmenter: SegmenterInstance;
  /** Whether a broadcaster is publishing right now. */
  isLive: () => boolean;
}

/**
 * The route that reports how the encode is doing, to be mounted at
 * {@link ENCODE_ROUTE_PREFIX}.
 *
 * Always `200`. A station nobody has broadcast to yet answers with
 * `keepingUp: null` at every rung — deliberately not `true`, which would
 * report a box that has never been asked to do anything as coping.
 */
export function encodeRoutes(deps: EncodeDependencies): Hono {
  const routes = new Hono();

  routes.get('/', (c) => {
    const report: EncodeReport = {
      live: deps.isLive(),
      segmentSeconds: deps.segmenter.segmentSeconds,
      segmentByteBudget: SEGMENT_BYTE_BUDGET,
      rungs: deps.segmenter.pace(),
    };

    return c.json(report, 200, {
      // It moves every poll while a broadcaster is publishing, and a cached
      // answer would tell an operator their box is fine some time after it
      // stopped being.
      'cache-control': 'no-store',
    });
  });

  return routes;
}
