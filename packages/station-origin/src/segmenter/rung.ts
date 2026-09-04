/**
 * A rung: one quality level a station offers its vibes at.
 *
 * Choosing a rung is choosing a price — each rung is its own address, priced
 * on its own by the connector in front of the origin
 * ([ADR 0002](../../../../docs/adr/0002-bitrate-follows-the-vibers-budget.md)).
 * Nothing here knows what a rung costs; the origin holds no payment code and a
 * price is connector configuration.
 *
 * Two numbers govern the shape of a rung and neither is incidental:
 *
 *   - **Segment duration is fixed.** A flat per-segment price is only honestly
 *     a per-second rate — and a viber's budget only a meaningful control — when
 *     every segment covers the same span
 *     ([ADR 0001](../../../../docs/adr/0001-a-segment-is-bounded-so-a-response-cap-cannot-break-it.md)).
 *
 *   - **The bitrate is a hard cap, not a target.** Constrained VBR — a maximum
 *     rate plus a buffer — is what turns "bitrate times duration" into a real
 *     bound on a segment's bytes rather than an expectation about its average.
 *     Average targeting would overshoot exactly when the picture gets busy,
 *     which is when a viber is least able to afford a segment that will not
 *     fit in one fulfill.
 *
 * This module is one rung wide on purpose: the configurable ladder, and the
 * startup refusal that re-runs the byte arithmetic over it, are issue #8. The
 * shape here is what that ladder will be a list of.
 *
 * @module
 */

/**
 * The most bytes a segment may be, at any rung
 * ([ADR 0001](../../../../docs/adr/0001-a-segment-is-bounded-so-a-response-cap-cannot-break-it.md)).
 *
 * A station's vibes come back to a viber as the *response* to a paid request,
 * and nothing in the connector bounds a response today. The bound is
 * self-imposed so that a station keeps working if that ever changes: the
 * request direction already has a hard 2 MiB ceiling, and mirroring it onto
 * responses is the obvious answer to the open question upstream.
 */
export const SEGMENT_BYTE_BUDGET = 2 * 1024 * 1024;

/** Fixed segment duration, in seconds (env: `TOON_SEGMENT_SECONDS`). */
export const DEFAULT_SEGMENT_SECONDS = 4;

/**
 * Seconds of encoder buffer the bitrate cap is allowed to smooth over.
 *
 * This is the `bufsize` half of constrained VBR, expressed relative to the
 * cap. It is deliberately short: the VBV guarantee is that any window of `T`
 * seconds holds at most `maxrate × T + bufsize` bits, so a long buffer would
 * let a single segment carry several seconds of slack and quietly break the
 * arithmetic the byte budget rests on. One second of buffer keeps a
 * four-second segment inside `5 × maxrate` bits.
 */
export const VBV_BUFFER_SECONDS = 1;

/**
 * What a rung is: a name that appears in its address, and the caps the encoder
 * may not exceed while producing it.
 */
export interface Rung {
  /**
   * The rung's name, which is also the address segment it is served beneath —
   * `/segments/<name>/<sequence>.ts`. It is the unit the connector prices, so
   * it must be a single, ordinary path segment.
   */
  name: string;
  /**
   * Video height in pixels. The width follows the source's aspect ratio, and
   * vibes that arrive smaller than this are not upscaled — paying more for a
   * bigger picture than the broadcaster sent would be a lie.
   */
  height: number;
  /** Hard cap on the video bitrate, in bits per second. Never a target. */
  videoBitrate: number;
  /** Hard cap on the audio bitrate, in bits per second. */
  audioBitrate: number;
}

/**
 * The rung a station offers unless it is told otherwise: the `720p` row of
 * [`docs/placeholder-numbers.md`](../../../../docs/placeholder-numbers.md).
 *
 * A placeholder, not a decision — and one rung, not a ladder. The ladder is
 * issue #8.
 */
export const DEFAULT_RUNG: Rung = {
  name: '720p',
  height: 720,
  videoBitrate: 1_800_000,
  audioBitrate: 128_000,
};

/**
 * What a rung may be called.
 *
 * A rung name is a path segment in a public address and the key a connector
 * route is written against, so it is kept to the characters that survive both
 * without escaping. Anything else is a refusal to start: a name carrying a
 * slash or a dot would let one rung's paths escape the prefix its price is
 * attached to, which is the one failure that turns into serving vibes for
 * free.
 */
export const RUNG_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A rung, or a segment duration, that the origin will not run with. */
export class RungError extends Error {
  override readonly name = 'RungError';
}

/**
 * The address prefix a rung's segments sit strictly beneath.
 *
 * This is the string a connector route is written against — one route per
 * rung, at that rung's price — so every path a viber can reach at that price
 * begins with it and no path outside it can be reached *by* it.
 */
export function rungPrefix(rung: string): string {
  return `/segments/${rung}/`;
}

/** The address of one segment at one rung. */
export function segmentPath(rung: string, sequence: number): string {
  return `${rungPrefix(rung)}${String(sequence)}.ts`;
}

/**
 * Check a rung and a segment duration, or refuse.
 *
 * Fail-closed, the same posture the stream key and the TLS pair already take:
 * a station that came up with a rung it cannot address, or a duration that
 * makes a flat price meaningless, is worse than one that did not come up.
 *
 * This is *not* the byte-budget check. Re-running ADR 0001's arithmetic over a
 * configured ladder and naming the rung that breaks it is issue #8.
 *
 * @throws RungError if the rung cannot be addressed or a number is unusable.
 */
export function assertRung(rung: Rung, segmentSeconds: number): void {
  if (!RUNG_NAME_PATTERN.test(rung.name)) {
    throw new RungError(
      `"${rung.name}" is not a usable rung name: a rung is a path segment and a price is attached to it, so it must match ${String(RUNG_NAME_PATTERN)}`
    );
  }
  if (!Number.isInteger(rung.height) || rung.height < 16) {
    throw new RungError(
      `rung "${rung.name}" has an unusable height: ${String(rung.height)}`
    );
  }
  for (const [what, bitrate] of [
    ['video', rung.videoBitrate],
    ['audio', rung.audioBitrate],
  ] as const) {
    if (!Number.isInteger(bitrate) || bitrate <= 0) {
      throw new RungError(
        `rung "${rung.name}" has an unusable ${what} bitrate: ${String(bitrate)}`
      );
    }
  }
  if (!Number.isInteger(segmentSeconds) || segmentSeconds <= 0) {
    throw new RungError(
      `segment duration must be a whole number of seconds, not ${String(segmentSeconds)}`
    );
  }
}
