/**
 * The station's stream key: the one secret the origin holds.
 *
 * A broadcaster's key is what stops anyone else broadcasting as their station.
 * It is **provisioned**, never generated here and never carried in the repo or
 * in a published image: the origin reads it from a file mounted onto the box
 * (`TOON_STREAM_KEY_FILE`) or, for a compose file that keeps its secrets in the
 * environment, from `TOON_STREAM_KEY`. `.gitignore` already covers `*.key` and
 * `*.secret`, which is what such a file is normally called.
 *
 * There is no default and there is no "unset means open". An origin with no
 * stream key refuses to start, because the alternative is a station anyone can
 * broadcast on that looks exactly like a working one.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * A stream key that could not be resolved.
 *
 * Named so the boot failure says which of the two mistakes was made — no key
 * at all, or two conflicting sources — rather than surfacing as a stack trace.
 */
export class StreamKeyError extends Error {
  override readonly name = 'StreamKeyError';
}

/** Where a stream key may come from. Exactly one must be supplied. */
export interface StreamKeySource {
  /** The key itself, e.g. read from `TOON_STREAM_KEY`. */
  streamKey?: string | undefined;
  /** Path to a file holding the key, e.g. a mounted `station.key`. */
  streamKeyFile?: string | undefined;
}

/**
 * Resolve the station's stream key, or throw.
 *
 * Trailing newlines are stripped, because a mounted key is usually written by
 * a human with an editor and `echo` appends one. Surrounding whitespace is
 * likewise not part of the key.
 *
 * @throws StreamKeyError if neither source is set, if both are, or if the
 * resolved key is empty or unreadable.
 */
export function resolveStreamKey(source: StreamKeySource): string {
  const hasLiteral = source.streamKey !== undefined && source.streamKey !== '';
  const hasFile =
    source.streamKeyFile !== undefined && source.streamKeyFile !== '';

  if (hasLiteral && hasFile) {
    throw new StreamKeyError(
      'both a stream key and a stream key file were supplied; set exactly one of TOON_STREAM_KEY and TOON_STREAM_KEY_FILE'
    );
  }
  if (!hasLiteral && !hasFile) {
    throw new StreamKeyError(
      'no stream key configured; mount one and set TOON_STREAM_KEY_FILE (or set TOON_STREAM_KEY). Ingest is gated on it and there is no default'
    );
  }

  let raw: string;
  if (hasFile) {
    const path = source.streamKeyFile as string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      // The path is safe to name; the contents are not, and are never logged.
      throw new StreamKeyError(
        `could not read the stream key file at ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  } else {
    raw = source.streamKey as string;
  }

  const key = raw.trim();
  if (key === '') {
    throw new StreamKeyError(
      hasFile
        ? `the stream key file at ${source.streamKeyFile as string} is empty`
        : 'TOON_STREAM_KEY is empty'
    );
  }
  return key;
}

/**
 * Whether a presented key is the station's key.
 *
 * Compared over digests in constant time. RTMP lets a publisher retry as fast
 * as it can open a socket, so a comparison that returns early on the first
 * wrong byte is a real oracle rather than a theoretical one. Digesting first
 * also keeps the comparison constant-time across keys of different lengths.
 */
export function streamKeyMatches(expected: string, presented: string): boolean {
  return timingSafeEqual(digest(expected), digest(presented));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
