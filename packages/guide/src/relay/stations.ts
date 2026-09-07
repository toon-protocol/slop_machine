/**
 * From an announcement log to the stations a viber can browse — pure
 * derivation, no socket and no clock of its own.
 *
 * Two rules live here and nowhere else:
 *
 * - **First-mover-wins per station address** (ADR 0004's v1 squatter
 *   defense): where two pubkeys announce one address, the announcement with
 *   the earlier `created_at` wins and the later claimant is dropped — a
 *   heuristic, not an authority, and named as exactly that in the ADR. Ties
 *   break to the lexically smaller event id, so two readers of one relay
 *   agree.
 * - **Liveness is the existence of an unexpired heartbeat, and nothing
 *   else.** The relay enforcing NIP-40 is a courtesy, not the contract; a
 *   consumer must apply the expiry itself or a non-pruning relay would show
 *   dead stations live. `isLive` is that application, against a clock the
 *   caller supplies — which is what lets the UI re-ask on a timer and drop a
 *   badge the moment a heartbeat lapses, with no reload.
 */

import type { NostrEvent } from '@/relay/nip01';
import {
  type AnnouncementLog,
  CATEGORY_TAG,
  EXPIRATION_TAG,
  HEARTBEAT_KIND,
  PROFILE_KIND,
  RUNG_TAG,
  SEGMENT_TAG,
  STATION_ADDRESS_TAG,
  STATION_ANNOUNCEMENT_KIND,
  tagValue,
} from '@/relay/announcements';

/**
 * One rung of an announced ladder. The price is the station's own
 * per-segment termination price, a decimal string of base units — rendered
 * verbatim, never parsed through a double, because a price rounded is a
 * price wrong.
 */
export interface StationRung {
  rung: string;
  price: string;
}

/** One announced station, everything a card or a page renders. */
export interface Station {
  /** The pubkey whose announcement won this address. */
  pubkey: string;
  /** The station's address — the prefix its hub granted it. */
  address: string;
  /** The last segment of the address: the handle, and the `/b/` route. */
  handle: string;
  /** When the standing announcement was made — the dedupe's own axis. */
  announcedAt: number;
  /** Display name from the kind 0 profile, where one has arrived. */
  name: string | null;
  /** Avatar URL from the profile. */
  picture: string | null;
  /** The station's own about — the announcement's content. */
  about: string;
  segmentSeconds: number | null;
  /** In ladder order, as the tags carry them. */
  rungs: StationRung[];
  /** Free-form, as the broadcaster described their own vibes. */
  categories: string[];
  /** The standing heartbeat's expiry in unix seconds, or null without one. */
  heartbeatExpiresAt: number | null;
}

/** A station is live exactly while its heartbeat is unexpired. */
export function isLive(station: Station, nowSeconds: number): boolean {
  return (
    station.heartbeatExpiresAt !== null &&
    station.heartbeatExpiresAt > nowSeconds
  );
}

interface Profile {
  name: string | null;
  picture: string | null;
}

function profileFrom(event: NostrEvent | undefined): Profile {
  if (event === undefined) return { name: null, picture: null };
  try {
    const content = JSON.parse(event.content) as Record<string, unknown>;
    return {
      name: typeof content['name'] === 'string' ? content['name'] : null,
      picture:
        typeof content['picture'] === 'string' ? content['picture'] : null,
    };
  } catch {
    return { name: null, picture: null };
  }
}

function heartbeatExpiry(event: NostrEvent | undefined): number | null {
  if (event === undefined) return null;
  const expiration = tagValue(event, EXPIRATION_TAG);
  if (expiration === null || !/^\d+$/.test(expiration)) return null;
  return Number(expiration);
}

/**
 * Every station the log announces, deduplicated first-mover-wins per
 * address and joined with its profile and heartbeat, oldest claim first.
 */
export function stationsFrom(log: AnnouncementLog): Station[] {
  /** The winning announcement per address. */
  const claims = new Map<string, NostrEvent>();

  for (const event of log.values()) {
    if (event.kind !== STATION_ANNOUNCEMENT_KIND) continue;
    const address = tagValue(event, STATION_ADDRESS_TAG);
    if (address === null || address === '') continue;

    const standing = claims.get(address);
    if (
      standing !== undefined &&
      (standing.created_at < event.created_at ||
        (standing.created_at === event.created_at && standing.id <= event.id))
    ) {
      continue; // The earlier claim stands; the later claimant is dropped.
    }
    claims.set(address, event);
  }

  const stations: Station[] = [];
  for (const [address, event] of claims) {
    const profile = profileFrom(
      log.get(`${String(PROFILE_KIND)}:${event.pubkey}`)
    );
    const segment = tagValue(event, SEGMENT_TAG);

    stations.push({
      pubkey: event.pubkey,
      address,
      handle: address.split('.').at(-1) ?? address,
      announcedAt: event.created_at,
      name: profile.name,
      picture: profile.picture,
      about: event.content,
      segmentSeconds:
        segment !== null && /^\d+$/.test(segment) ? Number(segment) : null,
      rungs: event.tags
        .filter((tag) => tag[0] === RUNG_TAG && tag[1] !== undefined)
        .map((tag) => ({ rung: tag[1] ?? '', price: tag[2] ?? '' })),
      categories: event.tags
        .filter((tag) => tag[0] === CATEGORY_TAG)
        .flatMap((tag) => (tag[1] === undefined ? [] : [tag[1]])),
      heartbeatExpiresAt: heartbeatExpiry(
        log.get(`${String(HEARTBEAT_KIND)}:${event.pubkey}`)
      ),
    });
  }

  return stations.sort(
    (left, right) =>
      left.announcedAt - right.announcedAt ||
      left.address.localeCompare(right.address)
  );
}
