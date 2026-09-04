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
 * The arithmetic those two numbers make possible is {@link segmentBytes}, and
 * {@link assertRung} is where it refuses: a rung whose cap times the fixed
 * duration exceeds {@link SEGMENT_BYTE_BUDGET} stops the origin at boot,
 * naming the rung. This module is one rung wide; the ladder a station is
 * configured with is `./ladder.ts`.
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
 *
 * A rung carrying only sound leaves `height` and `videoBitrate` off. That is
 * the cheapest rung on the shipped ladder and the one a viber on a small
 * budget lands on, so it is a shape of rung rather than a special case: either
 * both video fields are present or neither is.
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
   * bigger picture than the broadcaster sent would be a lie. Absent on a rung
   * that carries sound only.
   */
  height?: number | undefined;
  /**
   * Hard cap on the video bitrate, in bits per second. Never a target. Absent
   * on a rung that carries sound only.
   */
  videoBitrate?: number | undefined;
  /** Hard cap on the audio bitrate, in bits per second. */
  audioBitrate: number;
}

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

/** A rung, a ladder, or a segment duration that the origin will not run with. */
export class RungError extends Error {
  override readonly name = 'RungError';
}

/**
 * The address prefix a rung's segments — and only a rung's segments — sit
 * beneath. This is what a connector route is written against, at that rung's
 * price.
 */
export function rungPrefix(rung: string): string {
  return `/segments/${rung}/`;
}

/** The address of one segment at one rung. */
export function segmentPath(rung: string, sequence: number): string {
  return `${rungPrefix(rung)}${String(sequence)}.ts`;
}

/** Whether a rung carries a picture at all, or only sound. */
export function hasVideo(
  rung: Rung
): rung is Rung & { height: number; videoBitrate: number } {
  return rung.height !== undefined && rung.videoBitrate !== undefined;
}

/**
 * The most bytes one segment at this rung can be: **capped bitrate × fixed
 * duration**, which is the whole of ADR 0001's arithmetic.
 *
 * Deliberately the plain product and not a byte the encoder might actually
 * produce. The cap is a ceiling the encoder may not cross, so this is the
 * worst case rather than an average — and it is worst case *per rung*, because
 * each rung is priced and pulled on its own. The one-second VBV buffer is
 * excluded here on purpose: it is slack inside the cap, and the budget is
 * checked against the number a broadcaster can compute in their head from the
 * two numbers they wrote down.
 */
export function segmentBytes(rung: Rung, segmentSeconds: number): number {
  const bitsPerSecond = (rung.videoBitrate ?? 0) + rung.audioBitrate;
  return Math.ceil((bitsPerSecond * segmentSeconds) / 8);
}

/**
 * The highest total bitrate a rung may cap at, given a fixed duration, before
 * ADR 0001's budget refuses it. At four-second segments this is 4.19 Mbit/s,
 * which is why the shipped ladder tops out at 3 Mbit/s.
 */
export function bitrateCeiling(segmentSeconds: number): number {
  return Math.floor((SEGMENT_BYTE_BUDGET * 8) / segmentSeconds);
}

/**
 * Refuse a rung the origin must not run with.
 *
 * Fail-closed and at boot, before a port is bound: a bad ladder is a
 * refuse-to-start, never a degraded run. Two kinds of refusal live here and
 * both name the rung, because the operator's next move is to edit that line of
 * their ladder:
 *
 *   - a name that could not be addressed, or caps that are not numbers — a
 *     rung whose name escapes its own prefix could be reached at another
 *     rung's price;
 *   - a rung over the byte budget, which is ADR 0001 enforced rather than
 *     restated. The check is arithmetic over configuration, so it re-runs
 *     every time the origin starts: raising a bitrate and restarting is
 *     refused, and a bound cannot be quietly broken by a tweak.
 *
 * @throws RungError naming the rung, or the duration.
 */
export function assertRung(rung: Rung, segmentSeconds: number): void {
  if (!RUNG_NAME_PATTERN.test(rung.name)) {
    throw new RungError(
      `"${rung.name}" is not a usable rung name: a rung is a path segment and a price is attached to it, so it must match ${String(RUNG_NAME_PATTERN)}`
    );
  }
  if (!Number.isInteger(segmentSeconds) || segmentSeconds <= 0) {
    throw new RungError(
      `segment duration must be a whole number of seconds, not ${String(segmentSeconds)}`
    );
  }

  // Half a video rung would silently become an audio one, which is a different
  // thing at the same price.
  if ((rung.height === undefined) !== (rung.videoBitrate === undefined)) {
    throw new RungError(
      `rung "${rung.name}" has half a picture: a rung carries both a height and a video bitrate, or neither and only sound`
    );
  }
  if (hasVideo(rung) && (!Number.isInteger(rung.height) || rung.height < 16)) {
    throw new RungError(
      `rung "${rung.name}" has an unusable height: ${String(rung.height)}`
    );
  }
  for (const [what, bitrate] of [
    ['video', rung.videoBitrate],
    ['audio', rung.audioBitrate],
  ] as const) {
    if (bitrate === undefined) continue;
    if (!Number.isInteger(bitrate) || bitrate <= 0) {
      throw new RungError(
        `rung "${rung.name}" has an unusable ${what} bitrate: ${String(bitrate)}`
      );
    }
  }

  // ADR 0001, as arithmetic rather than as a comment.
  const bytes = segmentBytes(rung, segmentSeconds);
  if (bytes > SEGMENT_BYTE_BUDGET) {
    throw new RungError(
      `rung "${rung.name}" would produce segments of up to ${String(bytes)} bytes ` +
        `(${String((rung.videoBitrate ?? 0) + rung.audioBitrate)} bit/s × ${String(segmentSeconds)}s), ` +
        `over the ${String(SEGMENT_BYTE_BUDGET)}-byte budget of ADR 0001 — ` +
        `cap rung "${rung.name}" below ${String(bitrateCeiling(segmentSeconds))} bit/s in total, or shorten the segment`
    );
  }
}
