/**
 * ADR 0004, from the consumer's side: the kinds and tags a broadcaster
 * announces themselves with, and the replaceable-event bookkeeping a reader
 * owes them.
 *
 * The devnet's `announce.ts` is the producer of everything named here; these
 * literals are the guide's own copy of the schema, declared rather than
 * imported, so a schema change over there goes loudly red in a browser
 * instead of quietly agreeing with itself.
 */

import type { NostrEvent } from '@/relay/nip01';

/** The four kinds of ADR 0004. `0` and `1063` are standard Nostr. */
export const PROFILE_KIND = 0;
export const STATION_ANNOUNCEMENT_KIND = 11750;
export const HEARTBEAT_KIND = 11751;
export const CLIP_KIND = 1063;

/**
 * The station announcement's tags. The address tag is named for the wire —
 * ADR 0004 spells it — and this constant is the one place the guide spells
 * it too, exempted by name in the payment-free guard.
 */
export const STATION_ADDRESS_TAG = 'ilp';
export const SEGMENT_TAG = 'segment';
export const RUNG_TAG = 'rung';
export const CATEGORY_TAG = 't';

/** The heartbeat's NIP-40 expiry tag, in unix seconds. */
export const EXPIRATION_TAG = 'expiration';

/**
 * What currently stands, per replaceable slot: one event per
 * `<kind>:<pubkey>`. Kind 0, 11750 and 11751 are all replaceable, so this is
 * the whole state a discovery read accumulates.
 */
export type AnnouncementLog = Map<string, NostrEvent>;

/**
 * Absorb one event under replaceable semantics: the newest `created_at`
 * stands, and a tie breaks to the lexically smaller `id` — NIP-01's own
 * rule, so this reader and a relay that prunes agree on which event that is.
 * Returns whether the log changed, which is a consumer's cue to re-derive.
 */
export function absorb(log: AnnouncementLog, event: NostrEvent): boolean {
  const slot = `${String(event.kind)}:${event.pubkey}`;
  const standing = log.get(slot);
  if (
    standing !== undefined &&
    (standing.created_at > event.created_at ||
      (standing.created_at === event.created_at && standing.id <= event.id))
  ) {
    return false;
  }
  log.set(slot, event);
  return true;
}

/** The first value of the first tag with this name, or null. */
export function tagValue(event: NostrEvent, name: string): string | null {
  const tag = event.tags.find((candidate) => candidate[0] === name);
  return tag?.[1] ?? null;
}
