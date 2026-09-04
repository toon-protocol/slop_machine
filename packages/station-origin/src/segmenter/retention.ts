/**
 * Retention: the sliding window a station keeps, evicted by count.
 *
 * A station has a *now*, and vibes that have passed are past. A broadcast can
 * run for days, and nothing about the paid path bounds how much of it a node
 * accumulates — so the window is bounded here, explicitly, or the broadcaster's
 * disk is what eventually ends their broadcast.
 *
 * **Evicted by count, not by age or by bytes.** Count is the unit the rest of
 * the origin already speaks: a segment covers a fixed duration, so a window of
 * `n` segments is a window of `n × duration` seconds at every rung at once, and
 * a viber holding a sequence number can tell how far behind the edge it is
 * allowed to sit without knowing anything about the encoder. It is also the
 * only unit that makes the disk bound arithmetic rather than an expectation:
 * every rung is capped at {@link segmentBytes} per segment by ADR 0001, so
 * `retain × Σ segmentBytes` is a number an operator can compute from the two
 * lines of configuration they wrote — the same posture as the byte budget
 * itself. Evicting by age would leave the bound depending on how fast the
 * encoder happened to run; evicting by bytes would make the window a different
 * length at every rung, and a player climbing rungs mid-broadcast would find
 * the span it was on present at one price and gone at another.
 *
 * **The newest segment is never evicted.** The window keeps the *last* `retain`
 * sequences at a rung, so the sequence the station's *now* names is by
 * construction still on disk. A *now* that named a span a viber then paid for
 * and could not have would be worse than no *now* at all.
 *
 * **A segment past the window is gone, and asking for it is a clean
 * not-found** — `404` with `{"error": "unknown_segment"}`, exactly what an
 * unknown sequence has always been, and distinguishable from `unknown_rung`.
 * The viber re-syncs from *now* rather than paying for nothing. Nothing here
 * serves a stale body, and nothing hides the miss behind a redirect to the
 * live edge: which span to buy next is the payer's decision, not the station's.
 *
 * The window is configuration, fail-closed like the ladder: a retention that
 * is not a whole number of segments, or that would keep nothing, refuses the
 * start rather than quietly becoming some other number.
 *
 * Generated media is ignored by **directory** — `segments/`, never `*.ts` —
 * which is what makes it safe for this module to unlink files whose names
 * collide with the TypeScript extension. Eviction removes files the origin
 * itself wrote beneath `<dataDir>/segments/<rung>/` and nothing else.
 *
 * @module
 */

import { segmentBytes, type Rung } from './rung.js';

/**
 * How many segments a station keeps at each rung, by default (env:
 * `TOON_RETAIN_SEGMENTS`).
 *
 * A placeholder like every other number in this repo
 * ([`docs/placeholder-numbers.md`](../../../../docs/placeholder-numbers.md)),
 * chosen so the default ladder at the default duration bounds the disk at a
 * few hundred megabytes: sixty four-second segments is a four-minute window,
 * which is far more slack than a viber pulling at the live edge needs and
 * still small enough that a station can run on the cheapest box a broadcaster
 * would rent.
 */
export const DEFAULT_RETAIN_SEGMENTS = 60;

/** A retention window the origin will not run with. */
export class RetentionError extends Error {
  override readonly name = 'RetentionError';
}

/**
 * Refuse a retention window the origin must not run with.
 *
 * Fail-closed and at boot, before a port is bound and before a byte is
 * written, for the same reason the ladder is: a window of zero would be a
 * station that evicts every segment as fast as it produces it and reports a
 * *now* nobody can buy — a station that looks live and sells nothing.
 *
 * @throws RetentionError naming what was configured.
 */
export function assertRetention(retainSegments: number): void {
  if (!Number.isInteger(retainSegments) || retainSegments < 1) {
    throw new RetentionError(
      `retention must be a whole number of segments to keep at each rung, and at least 1, not ${String(retainSegments)}`
    );
  }
}

/**
 * Which of the sequences a rung is holding have fallen out of the window.
 *
 * Takes them in ascending order and returns the oldest ones, so that what is
 * kept is always the newest `retainSegments` — the live edge included.
 */
export function staleSequences(
  held: readonly number[],
  retainSegments: number
): number[] {
  const past = held.length - retainSegments;
  return past > 0 ? held.slice(0, past) : [];
}

/** How long a window of that many segments covers, in seconds. */
export function windowSeconds(
  retainSegments: number,
  segmentSeconds: number
): number {
  return retainSegments * segmentSeconds;
}

/**
 * The most bytes a station's segments can occupy on disk: the window, times
 * every rung's worst-case segment, across the whole ladder.
 *
 * The plain product of numbers an operator wrote down, exactly like
 * {@link segmentBytes} — worst case rather than an average, because the point
 * of the bound is that a broadcaster can size a disk from their configuration
 * before going live rather than by watching one fill.
 */
export function windowBytes(
  rungs: readonly Rung[],
  retainSegments: number,
  segmentSeconds: number
): number {
  return rungs.reduce(
    (total, rung) =>
      total + retainSegments * segmentBytes(rung, segmentSeconds),
    0
  );
}

/** The retention window, as a line an operator can check at boot. */
export function describeRetention(
  rungs: readonly Rung[],
  retainSegments: number,
  segmentSeconds: number
): string {
  const seconds = windowSeconds(retainSegments, segmentSeconds);
  const mib =
    windowBytes(rungs, retainSegments, segmentSeconds) / (1024 * 1024);
  return (
    `${String(retainSegments)} segments per rung (${String(seconds)}s of vibes), ` +
    `at most ${mib.toFixed(1)} MiB on disk across ${String(rungs.length)} rung(s)`
  );
}
