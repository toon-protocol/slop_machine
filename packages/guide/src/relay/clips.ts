/**
 * From a broadcaster's clip events to the clips a broadcaster page lists —
 * pure derivation, no socket and no clock of its own, like `stations.ts`.
 *
 * A clip is kind 1063, NIP-94-style, one event per clip (ADR 0004): a `url`
 * tag naming where the media lives, a `title`, a `duration` in seconds, the
 * description in `content`, and the event's own `created_at` as the
 * posted-at. Clips are NOT replaceable — every event is its own clip — so the
 * log here keys on the event id, never on `<kind>:<pubkey>`, and absorbing a
 * second event is a second clip rather than a replacement.
 *
 * Reading a clip costs nobody anything: the URL is fetched free — an Arweave
 * gateway in production, whatever the announcement names anywhere else — and
 * the guide only ever reads.
 */

import type { NostrEvent } from '@/relay/nip01';
import { CLIP_KIND, tagValue } from '@/relay/announcements';

/** The clip event's tags, NIP-94's own names (ADR 0004). */
const URL_TAG = 'url';
const TITLE_TAG = 'title';
const DURATION_TAG = 'duration';

/** One clip, everything the broadcaster page renders about it. */
export interface Clip {
  /** The event's own id — what tells one clip from another. */
  id: string;
  /** Where the media lives, fetched free. */
  url: string;
  title: string | null;
  durationSeconds: number | null;
  /** When it was posted — the event's own `created_at`, unix seconds. */
  postedAt: number;
  /** The description, free text. */
  description: string;
}

/** Every clip event that stands, keyed by event id. */
export type ClipLog = Map<string, NostrEvent>;

/**
 * Absorb one event: a clip is kept exactly when it is kind 1063, new to the
 * log, and names a URL — a clip with nowhere to fetch from is not a clip
 * anybody can play, so it is dropped rather than rendered dead. Returns
 * whether the log changed, the consumer's cue to re-derive.
 */
export function absorbClip(log: ClipLog, event: NostrEvent): boolean {
  if (event.kind !== CLIP_KIND) return false;
  if (log.has(event.id)) return false;
  const url = tagValue(event, URL_TAG);
  if (url === null || url === '') return false;
  log.set(event.id, event);
  return true;
}

/**
 * Every clip the log holds, newest first — posted-at is the event's own
 * `created_at`, and a tie breaks to the lexically smaller id, so two readers
 * of one relay agree on the order.
 */
export function clipsFrom(log: ClipLog): Clip[] {
  const clips: Clip[] = [];
  for (const event of log.values()) {
    const url = tagValue(event, URL_TAG);
    if (url === null || url === '') continue;
    const duration = tagValue(event, DURATION_TAG);
    clips.push({
      id: event.id,
      url,
      title: tagValue(event, TITLE_TAG),
      durationSeconds:
        duration !== null && /^\d+$/.test(duration) ? Number(duration) : null,
      postedAt: event.created_at,
      description: event.content,
    });
  }
  return clips.sort(
    (left, right) =>
      right.postedAt - left.postedAt || left.id.localeCompare(right.id)
  );
}

/** A duration as a person reads one: `0:06`, `1:30`, `12:05`. */
export function clipDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes)}:${String(rest).padStart(2, '0')}`;
}
