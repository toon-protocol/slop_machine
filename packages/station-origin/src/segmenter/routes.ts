/**
 * The served surface: a segment, addressed by rung and sequence number.
 *
 * ```
 * GET /segments/<rung>/<sequence>.ts
 * ```
 *
 * The shape is chosen for what sits in front of it. Every path a viber can
 * reach at one rung's price sits **strictly beneath that rung's own prefix**,
 * `/segments/<rung>/`, so the connector can terminate one route per rung at
 * that rung's price and no address can be reached at another address's price.
 * That is the same discipline `relay`'s `/write` route uses, and it is the
 * reason the rung comes before the sequence rather than after it. Addresses
 * that are not a segment — liveness today, the station's *now* tomorrow — sit
 * outside `/segments` entirely, so they can be priced (or left unpaid) on
 * their own.
 *
 * **No payment code lives here.** Nothing reads a payment header, nothing
 * requires one, and nothing echoes one back. By the time a request reaches
 * this handler the connector in front has already proven it paid; the origin's
 * whole job is to serve it.
 *
 * **No playlist is served.** A station serves segments and nothing else — the
 * client daemon already stands between the station and the player and
 * synthesizes whatever playlist its player wants over loopback. Serving one
 * here would double the paid requests per cycle and buy nothing.
 *
 * @module
 */

import { Hono } from 'hono';
import type { SegmenterInstance } from './segmenter.js';

/**
 * The prefix every segment address sits beneath.
 *
 * One level above the per-rung prefixes a connector route is written against,
 * and never itself a route: pricing this would price every rung the same.
 */
export const SEGMENTS_ROUTE_PREFIX = '/segments';

/** What a segment is, on the wire. HLS segments are MPEG-TS. */
export const SEGMENT_CONTENT_TYPE = 'video/mp2t';

/** A refusal a viber's player can act on. */
interface SegmentError {
  /**
   * Which kind of miss this is. A rung the station does not offer and a
   * sequence it does not have are told apart here, because the two call for
   * different moves: fall back to a rung that exists, or re-sync to the live
   * edge.
   */
  error: 'unknown_rung' | 'unknown_segment';
  message: string;
}

/**
 * The routes that serve segments, to be mounted at
 * {@link SEGMENTS_ROUTE_PREFIX}.
 *
 * The sequence is parsed here rather than matched in the path so that a
 * malformed address gets the same clean, distinguishable answer as an honest
 * one for a span that has gone.
 */
export function segmentRoutes(segmenter: SegmenterInstance): Hono {
  const routes = new Hono();

  routes.get('/:rung/:file', async (c) => {
    const rung = c.req.param('rung');

    if (!segmenter.hasRung(rung)) {
      return c.json<SegmentError>(
        {
          error: 'unknown_rung',
          message: `this station does not offer a rung called "${rung}"`,
        },
        404
      );
    }

    const sequence = parseSequence(c.req.param('file'));
    if (sequence === undefined) {
      return c.json<SegmentError>(
        {
          error: 'unknown_segment',
          message: 'a segment is addressed as <sequence>.ts',
        },
        404
      );
    }

    const found = await segmenter.read(rung, sequence);
    if (found.outcome !== 'ok') {
      return c.json<SegmentError>(
        {
          error:
            found.outcome === 'unknown-rung'
              ? 'unknown_rung'
              : 'unknown_segment',
          message: `this station is not holding sequence ${String(sequence)} at rung "${rung}"`,
        },
        404
      );
    }

    // Read whole, sent whole, with the length stated up front: a viber pays
    // once for a span they can actually play, so a partial body is worse than
    // no body. Nothing is streamed off disk while it is still being read.
    return new Response(found.body, {
      status: 200,
      headers: {
        'content-type': SEGMENT_CONTENT_TYPE,
        'content-length': String(found.body.length),
        // A segment was paid for by whoever pulled it. Letting a cache hand it
        // to the next viber for free would hand away the broadcaster's revenue.
        'cache-control': 'no-store',
      },
    });
  });

  return routes;
}

/** `"12.ts"` is sequence 12. Anything else is not a segment address. */
function parseSequence(file: string): number | undefined {
  const match = /^(\d{1,15})\.ts$/.exec(file);
  if (match?.[1] === undefined) return undefined;
  return Number(match[1]);
}
