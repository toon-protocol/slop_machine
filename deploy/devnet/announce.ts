/**
 * The announcements a broadcaster publishes, and the free reads that find
 * them — ADR 0004, implemented once.
 *
 * These live here rather than in `devnet.test.ts` for `paid.ts`'s own reason:
 * the test is not the only thing that announces — `demo.ts` announces the same
 * station with a person at the keyboard — and a second copy of "how a station
 * is announced" is a copy that drifts silently, with both callers still green
 * against two different ideas of the schema.
 *
 * ## The schema lives here; the evidence lives in the test
 *
 * Unlike `paid.ts`, this module DOES hold values of its own: the kind numbers
 * and tag layouts of ADR 0004, because they are the schema and the schema has
 * one implementation. What it never holds is a station's facts — the prefix,
 * the ladder, the prices, the categories all arrive as arguments, derived by
 * the caller from the run's own nodes. The suite still declares every kind and
 * every tag as a literal of its own and asserts them on what comes back off
 * the relay, so a schema change here goes red there rather than agreeing with
 * itself.
 *
 * ## Paid writes, free reads
 *
 * Publishing is one ordinary paid write per event through the hub's
 * `announce` route — the broadcaster's payer, like the quote and the buy, at
 * that route's price. Reading is NIP-01 over the relay's free read surface,
 * which is the seam the guide will stand at: announcements are found for
 * nothing, and being reachable is what costs.
 *
 * The heartbeat travels the PAID route too, never the free ephemeral lane.
 * An ephemeral kind is forwarded and never stored, so a consumer who arrives
 * later would read no liveness at all — liveness has to be a stored fact that
 * decays, which is what a NIP-40 expiry on a stored event is. ADR 0004 is the
 * whole argument.
 */

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import type { Payer } from './payer.js';

/**
 * The four kinds of ADR 0004. `0` and `1063` are standard — a profile any
 * Nostr client renders, and NIP-94 file metadata — and the two replaceable
 * kinds are this repository's own, adjacent because they are one schema and
 * chosen high in the simple-replaceable range, clear of the NIP-51 block.
 */
export const PROFILE_KIND = 0;
export const STATION_ANNOUNCEMENT_KIND = 11750;
export const HEARTBEAT_KIND = 11751;
export const CLIP_KIND = 1063;

/**
 * A broadcaster's public voice: the per-broadcaster Nostr keypair every
 * announcement event is signed with. Distinct from every key the money
 * touches — a leaked one costs a broadcaster their byline and nothing else.
 */
export interface BroadcasterVoice {
  secretKey: Uint8Array;
  /** The public half, hex — what a consumer queries the relay by. */
  pubkey: string;
}

/** The voice, from the 64-hex seed a run minted into its working directory. */
export function broadcasterVoice(secretHex: string): BroadcasterVoice {
  const secretKey = Uint8Array.from(Buffer.from(secretHex.trim(), 'hex'));
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

/** One announcement event, published and paid for. */
export interface PublishedEvent {
  event: NostrEvent;
  /** What the connector charged for the write — read off the claim, never asserted into it. */
  paid: bigint;
}

/**
 * Sign one event and pay the hub's announce route to carry it.
 *
 * The destination is a prefix the hub TERMINATES — the relay sits behind the
 * hub's own connector — so nothing is sealed to anybody else, exactly like the
 * quote and the buy.
 */
async function publish(
  payer: Payer,
  hubAddress: string,
  voice: BroadcasterVoice,
  template: { kind: number; tags: string[][]; content: string }
): Promise<PublishedEvent> {
  const event = finalizeEvent(
    { ...template, created_at: Math.floor(Date.now() / 1000) },
    voice.secretKey
  );

  const answer = await payer.client.send(`${hubAddress}.announce`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { event },
  });

  if (!answer.fulfilled) {
    throw new Error(
      `the hub refused a paid announcement write: ${answer.code} ${answer.message}`
    );
  }
  if (answer.status !== 200) {
    throw new Error(
      `the relay answered ${String(answer.status)} to a kind ${String(template.kind)} event: ${answer.text()}`
    );
  }

  return { event, paid: answer.claim?.amount ?? 0n };
}

/**
 * The profile — a standard kind 0, so any Nostr client on earth can render
 * and follow a broadcaster without the guide existing.
 */
export async function publishProfile(
  payer: Payer,
  hubAddress: string,
  voice: BroadcasterVoice,
  profile: { name: string; about: string; picture: string }
): Promise<PublishedEvent> {
  return publish(payer, hubAddress, voice, {
    kind: PROFILE_KIND,
    tags: [],
    content: JSON.stringify(profile),
  });
}

/** One rung of the announced ladder, at the station's own per-segment price. */
export interface AnnouncedRung {
  rung: string;
  /** Base units, held as bigint end to end — the station's own termination price. */
  price: bigint;
}

/**
 * The station announcement — replaceable, so a rung or price change is one
 * write and stale ladders never linger.
 *
 * Every fact here is the CALLER'S, derived from the run's own nodes: the
 * prefix is the one the hub granted, and the prices are the station
 * connector's own published per-segment terminations — the one price the
 * broadcaster is authoritative about. A viber's all-in price is the hub's
 * business, priced on the hub's own carried route.
 */
export async function publishStationAnnouncement(
  payer: Payer,
  hubAddress: string,
  voice: BroadcasterVoice,
  station: {
    prefix: string;
    segmentSeconds: number;
    /** In ladder order, which is the order the tags carry. */
    rungs: AnnouncedRung[];
    /** Free-form: the broadcaster describes their own vibes. */
    categories: string[];
    about: string;
  }
): Promise<PublishedEvent> {
  return publish(payer, hubAddress, voice, {
    kind: STATION_ANNOUNCEMENT_KIND,
    tags: [
      ['ilp', station.prefix],
      ['segment', String(station.segmentSeconds)],
      ...station.rungs.map((rung) => [
        'rung',
        rung.rung,
        rung.price.toString(),
      ]),
      ...station.categories.map((category) => ['t', category]),
    ],
    content: station.about,
  });
}

/**
 * The heartbeat — liveness IS the existence of an unexpired one.
 *
 * A short NIP-40 expiry, republished while on the air; when the process dies,
 * the claim expires on its own. There is deliberately no sign-off event — a
 * sign-off is published by exactly the process that just died.
 */
export async function publishHeartbeat(
  payer: Payer,
  hubAddress: string,
  voice: BroadcasterVoice,
  expiresAtSeconds: number
): Promise<PublishedEvent> {
  return publish(payer, hubAddress, voice, {
    kind: HEARTBEAT_KIND,
    tags: [['expiration', String(expiresAtSeconds)]],
    content: '',
  });
}

/**
 * One clip, one event — NIP-94-style, queried by the broadcaster's pubkey, so
 * publishing a new clip never touches the announcement.
 */
export async function publishClip(
  payer: Payer,
  hubAddress: string,
  voice: BroadcasterVoice,
  clip: {
    /** Where the clip lives — an Arweave URL, free to read. */
    url: string;
    title: string;
    durationSeconds: number;
    description: string;
  }
): Promise<PublishedEvent> {
  return publish(payer, hubAddress, voice, {
    kind: CLIP_KIND,
    tags: [
      ['url', clip.url],
      ['title', clip.title],
      ['duration', String(clip.durationSeconds)],
    ],
    content: clip.description,
  });
}

/** A NIP-01 filter, at the two fields a discovery read needs. */
export interface AnnouncementFilter {
  authors?: string[];
  kinds?: number[];
}

/**
 * How long a read is given before it is a failure rather than a slow relay.
 * Everything here is loopback, so this is a bound on a hang, not a budget.
 */
const READ_TIMEOUT_MS = 15_000;

/**
 * Read events back off the relay's FREE NIP-01 surface — the seam the guide
 * will consume, which is exactly why the suite asserts here rather than
 * trusting what it published.
 *
 * One REQ, everything until EOSE, then close. The relay enforces NIP-40
 * itself, and a consumer must too: an expired event that a non-pruning relay
 * still served would otherwise show a dead station live. Both halves of that
 * rule are the caller's to assert; this returns what the relay served.
 */
export async function readAnnouncements(
  relayUrl: string,
  filter: AnnouncementFilter
): Promise<NostrEvent[]> {
  const socket = new WebSocket(relayUrl);
  const subscription = 'devnet-read';
  const events: NostrEvent[] = [];

  return new Promise<NostrEvent[]>((settle, refuse) => {
    const timeout = setTimeout(() => {
      socket.close();
      refuse(
        new Error(
          `the relay at ${relayUrl} answered no EOSE within ${String(READ_TIMEOUT_MS)}ms`
        )
      );
    }, READ_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify(['REQ', subscription, filter]));
    });

    socket.addEventListener('message', (message: MessageEvent) => {
      const frame = JSON.parse(String(message.data)) as unknown[];
      if (frame[0] === 'EVENT' && frame[1] === subscription) {
        events.push(frame[2] as NostrEvent);
      }
      if (frame[0] === 'EOSE' && frame[1] === subscription) {
        clearTimeout(timeout);
        socket.close();
        settle(events);
      }
    });

    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      socket.close();
      refuse(
        new Error(
          `the relay at ${relayUrl} refused the connection — is its read port published?`
        )
      );
    });
  });
}
