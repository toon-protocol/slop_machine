/**
 * Establishing the **peering**: the one operator write a bought slot causes.
 *
 * A broadcaster buys a *slot*. What the hub's operator key does in response
 * is create a *peering* — and this module is named for that, mentions no
 * slot, and takes no roster (ADR 0003: collapsing the two words in the code
 * is what would turn this design into a violation of connector ADR 0043).
 *
 * One write, `POST /peers`, carrying four things and no more:
 *
 *   - **`id`, the hub's own local label for the peering** — the handle
 *     derived from the payer. Never derived from anything the counterparty
 *     asserts about itself; a peer's own ILP address is a claim, not a grant.
 *   - **`url`, the station connector's self-description URL**, which is the
 *     only thing the request body carried. Whatever answers that URL is who
 *     the peering is with: the connector fetches the document there and takes
 *     the endpoint, the edge identity and the settlement facts off it.
 *   - **`fee` and `max_packet_amount`, the hub's own policy** about this
 *     counterparty. A broadcaster does not choose how far the hub trusts
 *     them, so neither number is reachable from the request.
 *   - **`chain`, read from `X-TOON-Chain`** — the chain whose claim the
 *     hub's connector actually verified. Two nodes that settle on more than
 *     one chain in common is the one case with no honest default, and
 *     settling on the chain the broadcaster demonstrably paid on beats
 *     guessing between two.
 *
 * **The write is retry-safe, and it has to be**, because it can spend gas: it
 * may open a payment channel and wait for a chain to confirm it. Repeating it
 * against a peering already established finds the same channel and is a
 * success rather than a second channel, and the answer says which branch it
 * took — `found` or `created` — so an unintended second channel is visible in
 * the hub's own output rather than on a block explorer later.
 *
 * **A transient failure is retried inside the request**, so a slow chain does
 * not cost a broadcaster a purchase. What is *not* retried is anything the
 * hub already knows the answer to: a refusal about the station's own URL is
 * about the caller's node and will say the same thing however many times it
 * is asked, and retrying it only burns the packet's deadline.
 *
 * @module
 */

import type { WriteSigner } from '../operator/write-signature.js';

/** Where on the operator surface a peering is established. */
const PEERS_WRITE_PATH = '/peers';

/** How many times one peering write is attempted before it is given up on. */
const WRITE_ATTEMPTS = 3;

/** How long to wait before the nth retry, in milliseconds. */
const RETRY_BACKOFF_MS = [200, 500];

/** How long to wait for the operator surface, in milliseconds. */
const WRITE_TIMEOUT_MS = 20_000;

/** Which side a failed peering write is about. */
export type PeeringFailure =
  /**
   * The **station's** own connector: unreachable, redirecting, or describing
   * a node this hub cannot peer with. The hub reports it as being about the
   * broadcaster's node, because it is, and because the only person who can
   * fix it is the one reading the answer.
   */
  | 'station'
  /**
   * The **hub's** own surface: unreachable, refusing this app's key, or
   * failing on the chain. Nothing the broadcaster can do about it.
   */
  | 'hub';

/** A peering that could not be established, and whose node it is about. */
export class PeeringError extends Error {
  override readonly name = 'PeeringError';
  /** Whose node the failure is about. */
  readonly failure: PeeringFailure;
  /** What the operator surface said, where it said anything. */
  readonly detail: string;

  constructor(failure: PeeringFailure, message: string, detail = '') {
    super(message);
    this.failure = failure;
    this.detail = detail;
  }
}

/** The payment channel behind a peering, as the operator surface reports it. */
export interface PeeringChannel {
  /** The channel's on-chain identifier, read back from the chain. */
  id: string;
  /**
   * `created` for a channel this write opened, `found` for one that already
   * existed — which is what a repeat of the same write answers, and what
   * makes the write safe to retry inside a paid request.
   */
  status: string;
  /** Which chain it lives on. */
  chain: string;
}

/** An established peering, as the hub reads it back off its own connector. */
export interface EstablishedPeering {
  /** The hub's local label for it — the handle, as it was written. */
  localLabel: string;
  /** The payment channel behind it. */
  channel: PeeringChannel;
}

/** What establishing a peering needs. */
export interface PeeringDependencies {
  /** The hub's operator surface base URL and the terms it peers on. */
  policy: {
    operatorUrl: string;
    fee: number;
    maxPacketAmount: number;
  };
  /** The signer for the mounted operator write key. */
  signer: WriteSigner;
}

/** What one peering is established for. */
export interface PeeringRequest {
  /** The hub's own local label for the peering: the derived handle. */
  localLabel: string;
  /** The station connector's self-description URL, from the request body. */
  stationUrl: string;
  /**
   * The chain the broadcaster demonstrably paid on, or `undefined` where the
   * connector stated none — in which case a single shared chain is used and
   * several are refused by name rather than resolved silently.
   */
  chain: string | undefined;
}

/**
 * Establish the peering toward a station, retrying what is worth retrying.
 *
 * Resolves once the hub's connector has written the peering — synchronously,
 * inside the broadcaster's paid request, which is what makes the fulfill mean
 * *you are peered* rather than *your request is recorded*.
 *
 * @throws PeeringError naming whose node the failure is about.
 */
export async function establishPeering(
  deps: PeeringDependencies,
  request: PeeringRequest
): Promise<EstablishedPeering> {
  const { policy, signer } = deps;
  const target = new URL(`${policy.operatorUrl}${PEERS_WRITE_PATH}`);

  // Written out rather than serialized from a wider object, so that nothing a
  // caller sent can ever reach a field of this write by accident. `fee` and
  // `max_packet_amount` are the hub's; `id` is derived; `url` and `chain` are
  // the only two the request had any part in.
  const body = JSON.stringify({
    id: request.localLabel,
    url: request.stationUrl,
    fee: policy.fee,
    max_packet_amount: policy.maxPacketAmount,
    ...(request.chain === undefined ? {} : { chain: request.chain }),
  });

  let lastError: PeeringError | undefined;

  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 500);
    }

    // A FRESH signature per attempt, never the previous one re-sent. An
    // accepted signature is spent: the operator surface remembers it until it
    // expires and refuses a second write presenting it, so a retry that
    // replayed one would be refused for the wrong reason. The signer is what
    // guarantees freshness — it waits for the clock rather than repeating
    // itself — and this loop simply asks it again.
    const signature = await signer.sign('POST', target.pathname, body);

    let response: Response;
    try {
      response = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'signature-input': signature['signature-input'],
          signature: signature.signature,
          'content-digest': signature['content-digest'],
        },
        body,
        signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      });
    } catch (error) {
      // The hub could not reach its own connector. Worth retrying: a
      // connector restarting under a broadcaster's request is exactly the
      // transient failure a retry is for.
      lastError = new PeeringError(
        'hub',
        "the hub's own operator surface could not be reached",
        error instanceof Error ? error.message : String(error)
      );
      continue;
    }

    const said = await response.text();

    if (response.ok) {
      return read(request.localLabel, said);
    }

    if (response.status === 502) {
      // The connector's own word for "about the counterparty's host": the
      // station URL was unreachable, redirected, oversized, malformed, or
      // described a node this hub cannot peer with. Asking again cannot
      // change the answer, and the packet's deadline is the broadcaster's.
      throw new PeeringError(
        'station',
        'the station connector at that URL could not be read, or described a node this hub cannot peer with',
        said.trim()
      );
    }

    if (response.status < 500) {
      // 400 the request, 401 an unallowlisted key, 409 an id the hub's own
      // config file owns. All three are the hub's to fix and none of them
      // gets better by being asked twice.
      throw new PeeringError(
        'hub',
        `the hub's operator surface refused the peering write with ${String(response.status)}`,
        said.trim()
      );
    }

    lastError = new PeeringError(
      'hub',
      `the hub's operator surface answered ${String(response.status)}`,
      said.trim()
    );
  }

  throw (
    lastError ??
    new PeeringError('hub', 'the peering write was never attempted')
  );
}

/**
 * Read back what the operator surface answered.
 *
 * Only the two facts the hub has any use for are taken: which channel is
 * behind the peering, and whether this write opened it or found it. The rest
 * of the answer is the connector's own view of its table and is not
 * re-modelled here.
 */
function read(localLabel: string, said: string): EstablishedPeering {
  let answered: unknown;
  try {
    answered = JSON.parse(said);
  } catch {
    throw new PeeringError(
      'hub',
      "the hub's operator surface answered something that is not JSON"
    );
  }

  const channel = (answered as { channel?: unknown }).channel;
  if (typeof channel !== 'object' || channel === null) {
    throw new PeeringError(
      'hub',
      "the hub's operator surface established the peering but named no channel"
    );
  }

  const { id, status, chain } = channel as Record<string, unknown>;
  if (
    typeof id !== 'string' ||
    typeof status !== 'string' ||
    typeof chain !== 'string'
  ) {
    throw new PeeringError(
      'hub',
      "the hub's operator surface named a channel this app cannot read"
    );
  }

  return { localLabel, channel: { id, status, chain } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, ms));
}
