/**
 * The **forwarded routes**: one per address the station sells, so that being
 * peered is also being reachable.
 *
 * A peering is a relation; a routing table is what actually carries a packet.
 * A hub only forwards what its routing table names, so establishing the
 * peering and stopping there would leave a broadcaster peered and unreachable
 * — the purchase would have bought a relation nobody can address.
 *
 * One write per published prefix, `POST /routes/peers { prefix, peer_id,
 * price }`, where `peer_id` is the peering's local label and `price` is
 * **derived, never guessed**:
 *
 * ```
 *   hub route price  =  what the station publishes for that prefix
 *                    +  the hub's own carriage fee
 * ```
 *
 * That arithmetic is the whole reason the hub reads the station's own
 * document. The hub's connector charges a viber the route's price at its
 * client edge and retains this peering's `fee` for carrying the packet
 * (connector ADR 0028 and ADR 0061, `amount_after_fee`, a flat subtraction),
 * so what arrives at the station is `price - fee`. The station's own
 * connector then checks, per packet, that a peer-wire arrival covers the
 * price of the termination it resolves to (connector ADR 0029) and rejects
 * `F03` before the app is ever consulted. A hub route priced at anything less
 * than the station's own price plus the carriage is therefore a route that
 * forwards into a refusal — reachable, paid for, and dead.
 *
 * **The slope passes through untouched.** A price is a schedule over payload
 * length (connector ADR 0065) and a *fee* deliberately has none (ADR 0010,
 * ADR 0061): carriage work does not scale with a payload. So the carriage is
 * added to the base and `per_kib` is carried across exactly as published,
 * which makes the covering exact at every packet size rather than only at
 * small ones.
 *
 * **Only what sits beneath the prefix the hub granted is routed.** A station
 * publishes prefixes it terminates; a hub writing a routing-table row for one
 * of them is pointing an address at that node, and an address outside the
 * caller's own grant is not the caller's to be pointed at. Anything else the
 * station publishes is left alone, and a station that publishes nothing
 * beneath its grant is refused before the operator surface is touched at all
 * — that broadcaster has not written their granted prefix into their own
 * connector, and every packet the hub forwarded would arrive somewhere they
 * do not terminate.
 *
 * @module
 */

import type { PeeringDependencies } from './peering.js';

/** Where on the operator surface a forwarded route is written. */
const ROUTES_WRITE_PATH = '/routes/peers';

/** How many times one route write is attempted before it is given up on. */
const WRITE_ATTEMPTS = 3;

/** How long to wait before the nth retry, in milliseconds. */
const RETRY_BACKOFF_MS = [200, 500];

/** How long to wait for the operator surface, in milliseconds. */
const WRITE_TIMEOUT_MS = 20_000;

/** Which side a route that could not be written is about. */
export type ForwardedRouteFailure =
  /**
   * The **station's** own connector: it publishes nothing this hub can point
   * at the prefix it granted. About the broadcaster's node, and fixable only
   * there.
   */
  | 'station'
  /**
   * The hub's **config file** already owns that row. A runtime row never
   * shadows a config one (connector ADR 0034), so the hub operator reserved
   * this address and the app may not take it. Nothing the broadcaster can do,
   * and nothing that gets better by being asked again.
   */
  | 'config'
  /**
   * The hub's own surface: unreachable, refusing this app's key, or failing
   * on a write it should have taken.
   */
  | 'hub';

/** A forwarded route that could not be written, and whose side it is about. */
export class ForwardedRouteError extends Error {
  override readonly name = 'ForwardedRouteError';
  /** Whose side the failure is about. */
  readonly failure: ForwardedRouteFailure;
  /** The prefix being written when it failed, where there was one. */
  readonly prefix: string;
  /** What the operator surface said, where it said anything. */
  readonly detail: string;

  constructor(
    failure: ForwardedRouteFailure,
    message: string,
    prefix = '',
    detail = ''
  ) {
    super(message);
    this.failure = failure;
    this.prefix = prefix;
    this.detail = detail;
  }
}

/** One route the hub carries toward a station, priced from that station. */
export interface ForwardedRoute {
  /** The ILP prefix the hub carries — the station's own, beneath the grant. */
  prefix: string;
  /** What the station's own connector publishes for it. */
  stationPrice: bigint;
  /** What the hub's connector charges for it: the station's price plus carriage. */
  price: bigint;
  /** The station's own slope, carried across unchanged. `0n` on a flat price. */
  pricePerKib: bigint;
}

/** What the derivation needs beyond the document itself. */
export interface ForwardedRouteTerms {
  /**
   * The prefix the hub granted this caller. Only addresses at or beneath it
   * are routed, because only they are the caller's to be pointed at.
   */
  grantedPrefix: string;
  /** What the hub retains for carrying one packet — its own policy. */
  fee: number;
}

/** What the derivation produced, and what it deliberately left alone. */
export interface DerivedRoutes {
  /** The routes to write, in the order the station published them. */
  routes: ForwardedRoute[];
  /** Prefixes the station published that sit outside the caller's grant. */
  ignored: string[];
}

/** What writing the routes needs: a peering to point them at. */
export interface ForwardedRouteRequest {
  /** The peering's local label on the hub — the `peer_id` each route names. */
  localLabel: string;
  /** The routes to write, already derived. */
  routes: readonly ForwardedRoute[];
}

/**
 * Derive what the hub will charge for each address the station sells.
 *
 * Pure, and called **before** the peering is established: a station that
 * publishes nothing beneath its granted prefix is a refusal that costs the
 * hub no channel and the broadcaster no orphaned peering.
 *
 * @throws ForwardedRouteError with `failure: 'station'` where nothing the
 * station published sits beneath the granted prefix.
 */
export function deriveForwardedRoutes(
  published: readonly { prefix: string; price: bigint; pricePerKib: bigint }[],
  terms: ForwardedRouteTerms
): DerivedRoutes {
  const carriage = BigInt(terms.fee);
  const routes: ForwardedRoute[] = [];
  const ignored: string[] = [];

  for (const route of published) {
    if (!beneath(route.prefix, terms.grantedPrefix)) {
      ignored.push(route.prefix);
      continue;
    }
    routes.push({
      prefix: route.prefix,
      stationPrice: route.price,
      // The one piece of arithmetic in this app, and the reason the document
      // is read at all: the station's own number, plus the hub's carriage.
      price: route.price + carriage,
      pricePerKib: route.pricePerKib,
    });
  }

  if (routes.length === 0) {
    throw new ForwardedRouteError(
      'station',
      `the station connector at that URL publishes no priced address beneath ${terms.grantedPrefix}`,
      terms.grantedPrefix,
      published.length === 0
        ? 'it published no route prices at all'
        : `it publishes ${published.map((route) => route.prefix).join(', ')}`
    );
  }

  return { routes, ignored };
}

/**
 * Write every derived route to the hub's own connector, in order.
 *
 * Each write is signed afresh with the app's own key, and each is retried on
 * a transient failure the way the peering write is — a hub connector
 * restarting under a broadcaster's paid request must not cost them the
 * purchase. What is not retried is a row the hub's config file owns and a
 * request the surface refused: both say the same thing however many times
 * they are asked, and the packet's deadline is the broadcaster's to spend.
 *
 * **Keyed by prefix, so it is safe to repeat.** Posting the same prefix again
 * updates the row rather than adding a second one, which is what makes a
 * retried purchase — and, later, a renewal — write the same table rather than
 * a bigger one.
 *
 * @returns the routes as they were written, in the order they were written.
 * @throws ForwardedRouteError naming the prefix it stopped at and whose side
 * the failure is about.
 */
export async function writeForwardedRoutes(
  deps: PeeringDependencies,
  request: ForwardedRouteRequest
): Promise<ForwardedRoute[]> {
  const written: ForwardedRoute[] = [];
  for (const route of request.routes) {
    await writeOne(deps, request.localLabel, route);
    written.push(route);
  }
  return written;
}

async function writeOne(
  deps: PeeringDependencies,
  localLabel: string,
  route: ForwardedRoute
): Promise<void> {
  const { policy, signer } = deps;
  const target = new URL(`${policy.operatorUrl}${ROUTES_WRITE_PATH}`);

  // Written out rather than serialized from a wider object, so nothing a
  // caller sent can reach a field of this write by accident — and by hand
  // rather than through `JSON.stringify`, because a price is a `bigint` and
  // the surface expects the integer the config file's own spelling uses.
  const body = `{"prefix":${JSON.stringify(route.prefix)},"peer_id":${JSON.stringify(localLabel)},"price":${priceJson(route)}}`;

  let lastError: ForwardedRouteError | undefined;

  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 500);
    }

    // A fresh signature per attempt: an accepted signature is spent, so a
    // replay of the previous one would be refused for the wrong reason.
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
      lastError = new ForwardedRouteError(
        'hub',
        "the hub's own operator surface could not be reached",
        route.prefix,
        error instanceof Error ? error.message : String(error)
      );
      continue;
    }

    const said = await response.text();
    if (response.ok) return;

    if (response.status === 409) {
      // The connector's own word for "the config file owns this row". A
      // runtime row never shadows a config one, and the app must never take
      // an address the hub operator reserved.
      throw new ForwardedRouteError(
        'config',
        `the hub's own configuration file already owns the route for ${route.prefix}`,
        route.prefix,
        said.trim()
      );
    }

    if (response.status < 500) {
      throw new ForwardedRouteError(
        'hub',
        `the hub's operator surface refused the route for ${route.prefix} with ${String(response.status)}`,
        route.prefix,
        said.trim()
      );
    }

    lastError = new ForwardedRouteError(
      'hub',
      `the hub's operator surface answered ${String(response.status)} for ${route.prefix}`,
      route.prefix,
      said.trim()
    );
  }

  throw (
    lastError ??
    new ForwardedRouteError(
      'hub',
      `the route for ${route.prefix} was never attempted`,
      route.prefix
    )
  );
}

/**
 * A price as the operator surface takes it: a bare integer when the schedule
 * is flat — the spelling every route in the fleet uses — and a
 * `{ base, per_kib }` table when the station published a slope.
 *
 * Built as text rather than through `JSON.stringify` because these are
 * `bigint`s: a price is a `u64` of the asset's base units and passing one
 * through a double is how a route ends up priced a unit under the station's
 * own termination.
 */
function priceJson(route: ForwardedRoute): string {
  return route.pricePerKib === 0n
    ? route.price.toString()
    : `{"base":${route.price.toString()},"per_kib":${route.pricePerKib.toString()}}`;
}

/** Whether `prefix` is the granted prefix or an address beneath it. */
function beneath(prefix: string, granted: string): boolean {
  return prefix === granted || prefix.startsWith(`${granted}.`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, ms));
}
