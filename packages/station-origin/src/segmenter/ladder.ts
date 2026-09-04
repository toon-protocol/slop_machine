/**
 * The rung ladder: every quality a station offers, as ordinary configuration.
 *
 * A broadcaster trades bandwidth cost against quality by editing one string,
 * not by editing code — and because each rung is its own address at its own
 * price, editing the ladder is editing what a viber can buy. One ingest is
 * encoded at every rung on it, and each rung's segments are served strictly
 * beneath that rung's own prefix so the connector in front can price them one
 * route at a time.
 *
 * ## The spec
 *
 * ```
 * TOON_RUNGS="audio:128k,480p:480:800k:128k,720p:720:1800k:128k,1080p:1080:3000k:128k"
 * ```
 *
 * Rungs are separated by commas, fields within a rung by colons, and
 * whitespace around either is ignored so a compose file can wrap the line:
 *
 * ```
 * <name>:<height>:<video bitrate>:<audio bitrate>   a rung with a picture
 * <name>:<audio bitrate>                            a rung with only sound
 * ```
 *
 * A bitrate is bits per second, with the broadcast-conventional `k` and `M`
 * suffixes meaning thousands and millions (`1800k` is 1.8 Mbit/s, the same
 * number `ffmpeg` would take), because that is the unit the numbers are quoted
 * in everywhere else. Bitrates are **caps**, never targets.
 *
 * One flat string rather than a config file of its own: a ladder is four short
 * lines of numbers, the origin's other configuration is already flags over
 * environment over defaults, and a station's rungs have to be readable beside
 * the connector routes that price them in the same compose file. The one thing
 * that is not flat is the refusal — a ladder that breaks ADR 0001's byte
 * budget stops the origin at boot, naming the rung.
 *
 * @module
 */

import {
  assertRung,
  RUNG_NAME_PATTERN,
  RungError,
  segmentBytes,
  type Rung,
} from './rung.js';

/**
 * The ladder a station offers unless it is told otherwise, written the way an
 * operator writes it (env: `TOON_RUNGS`, flag: `--rungs`).
 *
 * This is the four-rung, four-second ladder of
 * [`docs/placeholder-numbers.md`](../../../../docs/placeholder-numbers.md) —
 * placeholders, not decisions, and safe to change. What is not safe to change
 * without re-reading
 * [ADR 0001](../../../../docs/adr/0001-a-segment-is-bounded-so-a-response-cap-cannot-break-it.md)
 * is the ceiling: at four-second segments the budget allows 4.19 Mbit/s, and
 * the top rung sits at 3 Mbit/s to leave headroom for VBR overshoot. A rung
 * above the ceiling is refused by the startup check rather than by review.
 */
export const DEFAULT_LADDER_SPEC =
  'audio:128k,480p:480:800k:128k,720p:720:1800k:128k,1080p:1080:3000k:128k';

/** {@link DEFAULT_LADDER_SPEC}, parsed. */
export const DEFAULT_LADDER: readonly Rung[] = parseLadder(DEFAULT_LADDER_SPEC);

/**
 * Parse a ladder spec into rungs.
 *
 * Fails closed on anything it cannot read rather than dropping the rung it did
 * not understand: a station that came up missing a rung would answer
 * `unknown_rung` to every viber whose player was told that rung exists, which
 * looks exactly like a station that never offered it.
 *
 * @throws RungError naming what could not be read.
 */
export function parseLadder(spec: string): Rung[] {
  const rungs = spec
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => parseRung(entry));

  if (rungs.length === 0) {
    throw new RungError(
      'a station with no rungs would serve nothing: give at least one rung, as <name>:<height>:<video bitrate>:<audio bitrate> or <name>:<audio bitrate>'
    );
  }
  return rungs;
}

/** One `<name>:…` entry of a ladder spec. */
function parseRung(entry: string): Rung {
  const fields = entry.split(':').map((field) => field.trim());
  const name = fields[0] ?? '';

  if (!RUNG_NAME_PATTERN.test(name)) {
    throw new RungError(
      `"${name}" is not a usable rung name: a rung is a path segment and a price is attached to it, so it must match ${String(RUNG_NAME_PATTERN)}`
    );
  }

  if (fields.length === 2) {
    return { name, audioBitrate: parseBitrate(fields[1], name, 'audio') };
  }
  if (fields.length === 4) {
    return {
      name,
      height: parseHeight(fields[1], name),
      videoBitrate: parseBitrate(fields[2], name, 'video'),
      audioBitrate: parseBitrate(fields[3], name, 'audio'),
    };
  }
  throw new RungError(
    `rung "${name}" is not a usable rung: write it as <name>:<height>:<video bitrate>:<audio bitrate>, or <name>:<audio bitrate> for sound only`
  );
}

function parseHeight(raw: string | undefined, name: string): number {
  const height = Number(raw);
  if (raw === undefined || raw === '' || !Number.isInteger(height)) {
    throw new RungError(
      `rung "${name}" has an unusable height: ${String(raw)} — a height is a whole number of pixels`
    );
  }
  return height;
}

/** `800k` and `1.8M` and `3000000` are all bits per second. */
function parseBitrate(
  raw: string | undefined,
  name: string,
  what: 'video' | 'audio'
): number {
  const match = /^(\d+(?:\.\d+)?)([kM]?)$/.exec(raw ?? '');
  if (match?.[1] === undefined) {
    throw new RungError(
      `rung "${name}" has an unusable ${what} bitrate: ${String(raw)} — a bitrate is bits per second, optionally suffixed k or M`
    );
  }
  const scale = match[2] === 'M' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1;
  const bitrate = Number(match[1]) * scale;
  if (!Number.isInteger(bitrate) || bitrate <= 0) {
    throw new RungError(
      `rung "${name}" has an unusable ${what} bitrate: ${String(raw)} — a bitrate is a whole number of bits per second`
    );
  }
  return bitrate;
}

/**
 * Refuse a ladder the origin must not run with, rung by rung.
 *
 * Three refusals, all at boot and all before a port is bound, because a bad
 * config is a refuse-to-start and never a degraded run:
 *
 *   - an empty ladder, which would serve nothing at every address;
 *   - two rungs of one name, which would put two encoders on one prefix and
 *     serve two different spans at an address a viber has already paid for;
 *   - a rung over ADR 0001's byte budget, named, from {@link assertRung}.
 *
 * @throws RungError naming the offending rung.
 */
export function assertLadder(
  rungs: readonly Rung[],
  segmentSeconds: number
): void {
  if (rungs.length === 0) {
    throw new RungError('a station with no rungs would serve nothing');
  }
  const seen = new Set<string>();
  for (const rung of rungs) {
    assertRung(rung, segmentSeconds);
    if (seen.has(rung.name)) {
      throw new RungError(
        `rung "${rung.name}" appears twice on the ladder: one rung is one address at one price, so its name has to be its own`
      );
    }
    seen.add(rung.name);
  }
}

/** A ladder as one line an operator can read in a log. */
export function describeLadder(
  rungs: readonly Rung[],
  segmentSeconds: number
): string {
  return rungs
    .map((rung) => {
      const picture =
        rung.videoBitrate === undefined
          ? 'sound only'
          : `${String(rung.height)}p at ${String(rung.videoBitrate)} bit/s`;
      return `${rung.name} (${picture}, up to ${String(segmentBytes(rung, segmentSeconds))} bytes a segment)`;
    })
    .join(', ');
}
