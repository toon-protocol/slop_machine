/**
 * The idle rule: no vibes for N seconds, and the station is off the air.
 *
 * A broadcaster's uplink usually does not close. It vanishes. The far end
 * loses power, a NAT forgets the flow, a phone walks out of coverage — and
 * none of those send a FIN or an RST. The socket sits **half-open**: the
 * origin's kernel still calls the connection ESTABLISHED, `close` never fires,
 * and nothing above the socket has any way to tell that from a broadcaster who
 * simply has not spoken this millisecond.
 *
 * `supersede()` in {@link module:ingest/ingest} covers the case where they
 * come back: an accepted publish takes the air from whatever held it, so a
 * reconnect over the corpse of the old connection is the ordinary path. What
 * it cannot cover is the broadcaster who **never comes back**. Nothing arrives
 * to supersede anything, so without a rule of its own the station reports
 * `live: true` for as long as that corpse lasts — which, behind a NAT that has
 * forgotten the flow, is for ever.
 *
 * That is the exact lie the station's *now* exists to prevent. A broadcaster
 * wants to tell "nobody is vibing" apart from "I am not actually live", and a
 * viber wants to tell a station that ended apart from one whose edge has
 * stalled. A `live: true` that never becomes false again destroys both
 * distinctions at once, and the sequence number sitting still beside it looks
 * identical to an encoder that is merely between segments.
 *
 * So the origin measures **vibes, not sockets**. The clock is reset by media
 * arriving on the publish that holds the air — audio, video or metadata — and
 * nothing else does. A connection that is open, healthy, acknowledging our
 * window and sending no media is a stalled edge, and the station says so, the
 * same as one whose wire was cut. TCP keepalive would answer a different and
 * weaker question ("is the peer's kernel there"), on a timescale of hours, and
 * would be satisfied by exactly the stalled publisher this rule is for.
 *
 * Taking the air is not the end of the station. The window already produced
 * stays on disk and stays servable at the sequences a viber already knows, the
 * encoder is stopped the way any ended publish stops it, and a broadcaster who
 * comes back later is accepted and continues the sequence rather than
 * restarting it at zero. The only thing the rule changes is that `live` tells
 * the truth.
 *
 * @module
 */

/**
 * How long a publish may go without vibes before it is taken off the air, in
 * seconds (env: `TOON_INGEST_IDLE_SECONDS`).
 *
 * A placeholder like every other number in this repo
 * ([`docs/placeholder-numbers.md`](../../../../docs/placeholder-numbers.md)),
 * and chosen from both ends. It has to be comfortably longer than any gap a
 * healthy publisher leaves: RTMP media arrives many times a second, and even a
 * publisher stalling through a bad few seconds of uplink is sending something
 * long before thirty. It has to be short enough that a viber who trusted
 * `live` is not misled for minutes — a thirty-second lie is roughly seven
 * segments at the default duration, which a player notices as a stalled edge
 * and re-syncs from rather than as a station that ended.
 *
 * Nothing about the encoder depends on it: the window on disk is unaffected by
 * when the air is taken, so an operator may tune it in either direction
 * without changing what a viber can buy.
 */
export const DEFAULT_INGEST_IDLE_SECONDS = 30;

/** An idle interval the origin will not run with. */
export class IngestIdleError extends Error {
  override readonly name = 'IngestIdleError';
}

/**
 * Refuse an idle interval the origin must not run with.
 *
 * Fail-closed and at boot, before the ingest port is bound, exactly like the
 * ladder and the retention window. There is deliberately **no value that
 * disables the rule**: an interval of zero or a negative one would not be a
 * station with a longer fuse, it would be a station that reports itself live
 * for ever the first time an uplink dies quietly — which is the bug this
 * module exists to close, reachable by typo. An operator who wants a long fuse
 * writes a long number.
 *
 * @throws IngestIdleError naming what was configured.
 */
export function assertIngestIdle(idleSeconds: number): void {
  if (!Number.isInteger(idleSeconds) || idleSeconds < 1) {
    throw new IngestIdleError(
      `the ingest idle interval must be a whole number of seconds, and at least 1, not ${String(idleSeconds)}`
    );
  }
}

/** The idle rule, as a line an operator can check at boot. */
export function describeIngestIdle(
  idleSeconds: number,
  segmentSeconds: number
): string {
  const segments = idleSeconds / segmentSeconds;
  return (
    `${String(idleSeconds)}s without vibes takes the station off the air ` +
    `(about ${segments.toFixed(1)} segment(s) at ${String(segmentSeconds)}s)`
  );
}
