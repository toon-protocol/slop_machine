/**
 * Reading the **station connector's own self-description** — the document at
 * the URL a purchase carried, and the only price list the hub ever uses.
 *
 * A connector answers a `GET` on its own client-edge URL with the facts a
 * stranger needs to transact with it (connector ADR 0050): the ILP addresses
 * it answers to, where clients reach it, its settlement facts, and **its
 * route prices**. That last part is why this module exists. The hub prices
 * every route it writes from what the station's own connector publishes, so
 * a broadcaster declares no price list, and there is no second declaration to
 * drift from the first — connector ADR 0067's lesson applied on the side that
 * can actually check it.
 *
 * **The shape, as the connector serializes it** (`connector_domain::node`,
 * `NodeSelfDescription` and `RoutePrice`):
 *
 * ```json
 * {
 *   "ilpAddresses": ["g.toon.slopmachine.demo.now"],
 *   "httpEndpoint": "https://station.example/ilp",
 *   "peerCarriages": ["http"],
 *   "routes": [
 *     { "prefix": "g.toon.slopmachine.demo.now", "price": "50" },
 *     { "prefix": "g.toon.slopmachine.demo.480p", "price": "1000",
 *       "pricePerKib": "30" }
 *   ],
 *   "supportedVersions": [1],
 *   "defaultVersion": 1
 * }
 * ```
 *
 * Only `routes` and `ilpAddresses` are read here. Everything else in the
 * document is the *connector's* business at `POST /peers` — it fetches the
 * same document itself and takes the endpoint, the edge identity and the
 * settlement facts off it — and re-reading those here would be a second
 * opinion about facts the peering already settled.
 *
 * **A price is a decimal string, and it is read as a `bigint`.** The document
 * spells prices as strings precisely because a `u64` of an asset's base units
 * is not representable in a JSON number a JavaScript reader can be trusted
 * with, and a hub that quietly rounded one would write a route priced below
 * the station's own termination — the exact failure the derivation exists to
 * prevent. A price that is not a string of digits is therefore a document
 * this hub refuses to read rather than one it guesses at.
 *
 * **The request is bounded and unretried**, on the terms connector ADR 0058
 * sets for the same fetch on the connector's side: a whole-exchange timeout,
 * a size cap, and no redirect followed — the broadcaster named a URL and this
 * reads *that* URL, because following a redirect would let the named host
 * hand the routing table to a different host. It is not retried, because
 * every failure here is a fact about the caller's own node that will say the
 * same thing however many times it is asked, and the packet's deadline is the
 * broadcaster's to spend.
 *
 * Failures are {@link PeeringError}s with `failure: 'station'`, which is the
 * hub's word for *this is about the counterparty's node*. That is deliberate:
 * a broadcaster whose connector cannot be read must get the same answer
 * whether it was the hub or the hub's connector that went and looked.
 *
 * @module
 */

import { PeeringError } from './peering.js';

/** The whole exchange's budget — connect, headers and body together. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The most document this will read.
 *
 * A self-description is a few hundred bytes on a node with several chains and
 * several routes. This is the same 64 KiB bound the connector reads one
 * under, and it is a bound rather than an expectation: the host is whoever
 * the buyer named.
 */
const MAX_DOCUMENT_BYTES = 64 * 1024;

/** The most of a non-document answer that is quoted back in a refusal. */
const MAX_DETAIL_BYTES = 200;

/**
 * An ILP address: dot-separated segments of the characters an address allows.
 *
 * A prefix that is not one cannot become a route on the hub's connector — the
 * operator surface refuses it — so it is refused here instead, where the
 * message can be about the document it came from.
 */
const ILP_ADDRESS = /^[a-zA-Z0-9_~-]+(\.[a-zA-Z0-9_~-]+)*$/;

/** A decimal price in the settlement asset's base units, as published. */
const DECIMAL = /^\d+$/;

/** One priced address a station's connector publishes, as this hub reads it. */
export interface PublishedRoute {
  /** The ILP prefix that address is reached at. */
  prefix: string;
  /**
   * What a packet of any size costs at that address, in the settlement
   * asset's base units. A `bigint`, because the document's own spelling is a
   * decimal string and a hub is not entitled to round it.
   */
  price: bigint;
  /**
   * What each started kibibyte of payload adds (connector ADR 0065), or `0n`
   * where the document published no slope — which is every station route, and
   * is why `0n` rather than `undefined`: a flat price is a schedule whose
   * slope is zero, not a different kind of price.
   */
  pricePerKib: bigint;
}

/** A station connector's self-description, as far as this hub reads it. */
export interface StationDescription {
  /** Every ILP address that node answers to, as it published them. */
  ilpAddresses: string[];
  /** Every priced address it publishes, in the order it published them. */
  routes: PublishedRoute[];
}

/**
 * Read the self-description a station connector publishes at `url`.
 *
 * @param url - the station connector's own URL, exactly as the purchase
 * carried it. Typically the connector's base URL with `/ilp` on the end.
 * @returns what that node published about itself, as far as the hub reads it.
 * @throws PeeringError with `failure: 'station'` — unreachable, redirecting,
 * oversized, not JSON, or publishing something this hub cannot price a route
 * from. Every one of them is about the caller's own node.
 */
export async function readStationDescription(
  url: string
): Promise<StationDescription> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      // The URL the broadcaster named, and no other. A `3xx` is refused
      // below rather than followed.
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw unreadable(
      'the station connector at that URL could not be reached',
      error instanceof Error ? error.message : String(error)
    );
  }

  if (response.status >= 300 && response.status < 400) {
    throw unreadable(
      'the station connector at that URL redirected rather than answering',
      `${String(response.status)} to ${response.headers.get('location') ?? '(nowhere named)'}`
    );
  }
  if (!response.ok) {
    throw unreadable(
      'the station connector at that URL answered something other than a self-description',
      `${String(response.status)} ${await safeText(response)}`
    );
  }

  const document = await bounded(response);

  let published: unknown;
  try {
    published = JSON.parse(document);
  } catch {
    throw unreadable(
      'the station connector at that URL did not answer JSON',
      `${document.slice(0, 120)}…`
    );
  }
  if (typeof published !== 'object' || published === null) {
    throw unreadable(
      'the station connector at that URL answered JSON that is not a self-description'
    );
  }

  return {
    ilpAddresses: addressesOf(published),
    routes: routesOf(published),
  };
}

/**
 * The body, refused rather than buffered whole once it runs past the cap.
 *
 * A declared `Content-Length` past the bound is refused before a byte of body
 * is read; a host that declares nothing and then dribbles is caught by the
 * running count as it streams.
 */
async function bounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) {
    throw tooLarge();
  }

  const body = response.body;
  if (body === null) return '';

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let read = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      read += chunk.value.length;
      if (read > MAX_DOCUMENT_BYTES) throw tooLarge();
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text + decoder.decode();
}

function tooLarge(): PeeringError {
  return unreadable(
    'the station connector at that URL answered a document larger than this hub reads',
    `the bound is ${String(MAX_DOCUMENT_BYTES)} bytes`
  );
}

/** Every ILP address the document published, ignoring anything unreadable. */
function addressesOf(published: object): string[] {
  const stated = (published as { ilpAddresses?: unknown }).ilpAddresses;
  if (!Array.isArray(stated)) return [];
  return stated.filter(
    (address): address is string =>
      typeof address === 'string' && ILP_ADDRESS.test(address)
  );
}

/**
 * Every priced address the document published.
 *
 * An entry this hub cannot read is the **whole document** refused, never a
 * route quietly dropped: a rung skipped in silence is a rung the broadcaster
 * paid to have routed and cannot reach, discovered only by a viber's packet
 * arriving nowhere.
 */
function routesOf(published: object): PublishedRoute[] {
  const stated = (published as { routes?: unknown }).routes;
  if (stated === undefined) return [];
  if (!Array.isArray(stated)) {
    throw unreadable(
      'the station connector at that URL published a "routes" that is not a list of priced addresses'
    );
  }

  return stated.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw unreadable(
        `the station connector at that URL published a route this hub cannot read (number ${String(index + 1)})`
      );
    }
    const { prefix, price, pricePerKib } = entry as Record<string, unknown>;

    if (typeof prefix !== 'string' || !ILP_ADDRESS.test(prefix)) {
      throw unreadable(
        `the station connector at that URL published a route whose prefix is not an ILP address: ${JSON.stringify(prefix)}`
      );
    }
    if (typeof price !== 'string' || !DECIMAL.test(price)) {
      throw unreadable(
        `the station connector at that URL published ${prefix} at a price this hub cannot read: ${JSON.stringify(price)}. A published price is a decimal string of the settlement asset's base units`
      );
    }
    if (
      pricePerKib !== undefined &&
      (typeof pricePerKib !== 'string' || !DECIMAL.test(pricePerKib))
    ) {
      throw unreadable(
        `the station connector at that URL published ${prefix} with a per-kibibyte price this hub cannot read: ${JSON.stringify(pricePerKib)}`
      );
    }

    return {
      prefix,
      price: BigInt(price),
      pricePerKib: pricePerKib === undefined ? 0n : BigInt(pricePerKib),
    };
  });
}

/** Every failure here is about the counterparty's node, and says so. */
function unreadable(message: string, detail = ''): PeeringError {
  return new PeeringError('station', message, detail);
}

/**
 * The first {@link MAX_DETAIL_BYTES} of whatever a URL answered instead of a
 * document, for the message that names it.
 *
 * Bounded on the same reasoning the document is: a host that answers a
 * refusal with a gigabyte is still a host the buyer chose, and the hub is
 * reading it inside a paid request.
 */
async function safeText(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  try {
    const chunk = await reader.read();
    if (chunk.done) return '';
    return new TextDecoder()
      .decode(chunk.value.subarray(0, MAX_DETAIL_BYTES))
      .trim();
  } catch {
    return '';
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
