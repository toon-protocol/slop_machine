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
 * **A row the station has stopped publishing is taken back out.** Writing is
 * keyed by prefix, so a repeat purchase rewrites what is still sold — but
 * nothing about an upsert removes what is not, and a rung dropped from a
 * ladder would otherwise leave its row behind for ever: an address the hub
 * carries, priced, toward a node that no longer terminates it, where every
 * forwarded packet arrives at an `F03`. So {@link retireForwardedRoutes}
 * reads what the hub's own table currently holds and removes what the
 * document no longer names, with one `DELETE /routes/peers/:prefix` each.
 *
 * **Removing a row is a destructive write against a table every broadcaster
 * shares, and it is fenced twice.** A runtime row is upserted by prefix
 * rather than protected by an owner — only a *config* row is protected, by
 * the connector's own `409`. So the fence is this module's to hold:
 *
 *   1. the candidates are read from the hub's own table and filtered to rows
 *      the caller can be **proven** to own — see {@link RouteOwnership} —
 *      which is an address space and a peering label no other caller can ever
 *      hold, because a handle is derived from a verified payer and lengthened
 *      until it is free, so two grants never nest;
 *   2. and {@link removeOne}, the only function that issues the `DELETE`,
 *      re-checks that same proof itself and refuses rather than sending
 *      anything it cannot establish is the caller's.
 *
 * A row the config file owns is never a candidate — the read says which rows
 * are the operator's own — and the connector would refuse it anyway.
 *
 * **And when the slot behind them lapses, every row goes**, not just the
 * stale ones: {@link withdrawForwardedRoutes}. That is the first half of a
 * teardown and the reason the halves are in this order — the connector
 * refuses to remove a peering a runtime route still forwards to
 * (`PeerRouteTableError::PeerInUse`, a `409`), so releasing the peering first
 * is a teardown that stops half-way through. The candidates there are the
 * union of both ownership proofs {@link RouteOwnership} names, because the
 * referential rule is keyed on the **peering label** while the fence a
 * broadcaster's grant provides is keyed on the **prefix**, and a teardown has
 * to satisfy the first while staying inside the second.
 *
 * **The read is bearer-gated, and the removal is signature-gated**, which is
 * the connector's own split: writes are RFC 9421 signatures and never a
 * bearer token, reads are the bearer token and nothing else.
 *
 * @module
 */

import type {
  PeeringDependencies,
  PeeringReadDependencies,
} from './peering.js';
import type { PublishedRoute } from './station-description.js';

/** Where on the operator surface a forwarded route is written. */
const ROUTES_WRITE_PATH = '/routes/peers';

/**
 * Where on the operator surface the rows this hub already carries are read.
 *
 * The same address as the write, on the other verb — and behind the other
 * gate: a read is the bearer token and nothing else.
 */
const ROUTES_READ_PATH = '/routes/peers';

/**
 * An ILP address, as the operator surface will accept one in a path.
 *
 * Checked before a prefix read back off the hub's own table is ever put in a
 * URL. The row was written by whoever holds the hub's write key, which
 * includes the hub operator's own hand, so it is not this app's to assume
 * well-formed — and a prefix carrying a `/` or a `..` would be a `DELETE`
 * aimed at a path nobody named.
 */
const ILP_ADDRESS = /^[a-zA-Z0-9_~-]+(\.[a-zA-Z0-9_~-]+)*$/;

/** How long to wait for a read of the hub's own table, in milliseconds. */
const READ_TIMEOUT_MS = 10_000;

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
 * What removing a route needs beyond what writing one does: the credential
 * that gates a **read** of the hub's own table.
 *
 * Nothing can be removed without first knowing what is there, and what is
 * there is a read. The token is here rather than on the peering policy
 * because it is a credential and not a term: a policy is configuration an
 * operator reads back, and this is a secret that never appears in one.
 *
 * **Reads only.** The connector gates its writes on an RFC 9421 signature and
 * never on a bearer token, and this app does not invent a shortcut: the
 * `DELETE` below is signed with the write key exactly as the `POST` is.
 */
export type ForwardedRouteDependencies = PeeringReadDependencies;

/** One row the hub's own routing table holds right now, as this hub reads it. */
export interface CarriedRoute {
  /** The ILP prefix that row carries. */
  prefix: string;
  /**
   * The peering it points at — the operator surface's `peer_id`.
   *
   * This is what the connector's own referential rule is keyed on, so it is
   * what a teardown selects by: every row naming a peering's label has to be
   * gone before that peering can be released.
   */
  peerId: string;
  /**
   * `runtime` for a row written over the operator surface, `config` for one
   * the hub operator's own file owns.
   *
   * Read rather than assumed, because it is the difference between a row this
   * app may take back out and one it may never touch.
   */
  source: string;
  /**
   * What the hub charges to carry it, in the operator's own two spellings — a
   * bare integer for a flat price, a `{ base, per_kib }` table for one with a
   * slope (connector ADR 0065).
   *
   * `undefined` where the row carried no price this app could read, which is
   * not the same as a row priced at nothing: a removal needs a prefix and
   * nothing else, and a reconciliation that could not read a price leaves the
   * row alone rather than rewriting it on a guess.
   */
  price?: number | { base: number; per_kib: number };
}

/**
 * What proves a row is this caller's to remove.
 *
 * Two independent proofs, and either is enough:
 *
 *   - the row's prefix is **at or beneath the granted prefix**, which is an
 *     address space no other caller can hold — a handle is derived from a
 *     verified payer and lengthened until it is free, so two grants never
 *     nest;
 *   - or the row **forwards to this caller's own peering label**, which is
 *     the same derived label and equally nobody else's.
 *
 * The second exists because the connector's referential rule is keyed on the
 * label rather than on the prefix: a peering cannot be removed while any
 * runtime route still forwards to it. A teardown that could only remove rows
 * beneath the grant would be refused `409` by a row pointing at the peering
 * from anywhere else — a hand-written one, say — and would stop half-way
 * through, which is exactly the failure the ordering exists to avoid.
 */
export interface RouteOwnership {
  /** The prefix the hub granted this caller. */
  grantedPrefix: string;
  /**
   * This caller's own peering label, where the caller has one to offer.
   * `undefined` narrows the proof to the prefix alone.
   */
  localLabel?: string | undefined;
}

/** What taking the stale rows back out needs. */
export interface ForwardedRouteRetirement {
  /**
   * The prefix the hub granted this caller.
   *
   * **The whole fence.** Nothing outside this address space is a candidate
   * for removal, and nothing outside it is sent even if it somehow became
   * one: a hub's routing table is shared by every broadcaster it admitted,
   * and a runtime row carries no owner for the connector to check.
   */
  grantedPrefix: string;
  /**
   * The routes the hub carries for this caller now. Everything else beneath
   * the grant is what the station has stopped publishing, and goes.
   */
  keep: readonly ForwardedRoute[];
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
  published: readonly PublishedRoute[],
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
 * Take back out every row beneath the granted prefix the station no longer
 * publishes.
 *
 * Called **after** the writes rather than before them, so the hub's table is
 * briefly a superset of what the station sells rather than briefly a subset:
 * a rung is never unreachable in the middle of its own broadcaster's renewal.
 *
 * A `404` from the surface is a success, not a failure — the row is already
 * gone, which is the state this was asking for, and a retried purchase must
 * not be refused for finishing work its predecessor did.
 *
 * @returns the prefixes removed, in the order they were removed. Empty on a
 * first purchase, and empty on a renewal that dropped nothing.
 * @throws ForwardedRouteError with `failure: 'hub'` where the hub's own
 * surface would not answer the read or take the removal, and
 * `failure: 'config'` where the row turns out to be one the operator's
 * configuration file owns.
 */
export async function retireForwardedRoutes(
  deps: ForwardedRouteDependencies,
  request: ForwardedRouteRetirement
): Promise<string[]> {
  const published = new Set(request.keep.map((route) => route.prefix));

  const stale = (await readCarriedRoutes(deps)).filter(
    (carried) =>
      // A row the operator's own configuration file owns is never this app's
      // to remove. The connector would refuse it with a 409 anyway; not
      // asking is better than being told.
      carried.source === 'runtime' &&
      beneath(carried.prefix, request.grantedPrefix) &&
      !published.has(carried.prefix)
  );

  const removed: string[] = [];
  for (const carried of stale) {
    await removeOne(deps, { grantedPrefix: request.grantedPrefix }, carried);
    removed.push(carried.prefix);
  }
  return removed;
}

/**
 * Take **every** row this caller has out — the whole routing table entry, not
 * the stale part of it.
 *
 * This is the first half of a teardown and its whole reason for existing is
 * the order: the connector refuses to remove a peering a runtime route still
 * forwards to (`PeerRouteTableError::PeerInUse`, a `409`), so a teardown that
 * released the peering first would be refused and would stop half-way
 * through, leaving a hub carrying priced addresses toward a station it no
 * longer peers with.
 *
 * Candidates are every **runtime** row that is provably this caller's by
 * either proof {@link RouteOwnership} names — beneath the grant, or pointing
 * at their peering label. The union is deliberate: the prefix half is what
 * makes the removal complete from the broadcaster's point of view, and the
 * label half is what makes it complete from the *connector's*, which is the
 * one that decides whether the peering can then go.
 *
 * A row the operator's own configuration file owns is never a candidate and
 * never removed — it is not this app's, the connector would refuse it, and a
 * config row cannot hold a runtime peering in use anyway.
 *
 * @returns the prefixes removed, in the order they were removed.
 * @throws ForwardedRouteError where the hub's own surface would not answer
 * the read or take a removal. Nothing is released after that: a teardown that
 * could not finish its first half must not start its second.
 */
export async function withdrawForwardedRoutes(
  deps: ForwardedRouteDependencies,
  owner: RouteOwnership
): Promise<string[]> {
  const mine = (await readCarriedRoutes(deps)).filter(
    (carried) => carried.source === 'runtime' && proven(owner, carried)
  );

  const removed: string[] = [];
  for (const carried of mine) {
    await removeOne(deps, owner, carried);
    removed.push(carried.prefix);
  }
  return removed;
}

/**
 * Every peer-forwarding row the hub's own connector holds, config and runtime
 * alike, each saying which it is.
 *
 * Bearer-gated, because it is a read. Retried on the same terms a write is:
 * a connector restarting under a broadcaster's paid request must not cost
 * them the purchase.
 *
 * The answer is not size-bounded the way a station's self-description is —
 * that document comes from a host the buyer named, and this one comes from
 * the hub's own connector on the hub's own network.
 */
export async function readCarriedRoutes(
  deps: ForwardedRouteDependencies
): Promise<CarriedRoute[]> {
  const target = new URL(`${deps.policy.operatorUrl}${ROUTES_READ_PATH}`);
  let lastError: ForwardedRouteError | undefined;

  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 500);
    }

    let response: Response;
    try {
      response = await fetch(target, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${deps.bearerToken}`,
        },
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = new ForwardedRouteError(
        'hub',
        "the hub's own operator surface could not be reached",
        '',
        error instanceof Error ? error.message : String(error)
      );
      continue;
    }

    const said = await response.text();

    if (response.ok) return readRows(said);

    if (response.status < 500) {
      // 401 is the bearer token, which is the hub operator's mount to fix and
      // says the same thing however many times it is asked.
      throw new ForwardedRouteError(
        'hub',
        `the hub's operator surface refused to say what it carries, with ${String(response.status)}`,
        '',
        said.trim()
      );
    }

    lastError = new ForwardedRouteError(
      'hub',
      `the hub's operator surface answered ${String(response.status)} when asked what it carries`,
      '',
      said.trim()
    );
  }

  throw (
    lastError ??
    new ForwardedRouteError('hub', "the hub's own table was never read")
  );
}

/**
 * The rows out of that answer, ignoring anything this app cannot read.
 *
 * Ignoring rather than refusing, and it is the opposite choice from the one
 * the station's document gets: a row this app cannot parse is a row it will
 * not remove, which is the safe direction. A price it cannot read is not read
 * at all here — removing a route needs its prefix and nothing else.
 */
function readRows(said: string): CarriedRoute[] {
  let answered: unknown;
  try {
    answered = JSON.parse(said);
  } catch {
    throw new ForwardedRouteError(
      'hub',
      "the hub's operator surface answered something that is not JSON when asked what it carries"
    );
  }
  if (!Array.isArray(answered)) {
    throw new ForwardedRouteError(
      'hub',
      "the hub's operator surface answered something that is not a routing table"
    );
  }

  const rows: CarriedRoute[] = [];
  for (const entry of answered) {
    if (typeof entry !== 'object' || entry === null) continue;
    const {
      prefix,
      peer_id: peerId,
      source,
    } = entry as Record<string, unknown>;
    if (typeof prefix !== 'string' || typeof source !== 'string') continue;
    rows.push({
      prefix,
      peerId: typeof peerId === 'string' ? peerId : '',
      source,
      ...readPrice((entry as Record<string, unknown>)['price']),
    });
  }
  return rows;
}

/**
 * A row's price, in whichever of the two spellings it arrived in, or nothing
 * at all where it is neither.
 *
 * Nothing here refuses: a price this app cannot read is a price it will not
 * compare against, and the row keeps every other use it had.
 */
function readPrice(stated: unknown): { price?: CarriedRoute['price'] } {
  if (typeof stated === 'number') return { price: stated };
  if (typeof stated !== 'object' || stated === null) return {};
  const { base, per_kib: perKib } = stated as Record<string, unknown>;
  if (typeof base !== 'number' || typeof perKib !== 'number') return {};
  return { price: { base, per_kib: perKib } };
}

/**
 * Remove one row, and refuse to send anything that is not provably beneath
 * the grant it was given.
 *
 * This is the choke point, and the check is repeated here on purpose. Every
 * caller already filtered — but this is the only function in the app that
 * issues a destructive write against a hub's routing table, and a fence that
 * lives only in the caller is a fence one refactor away from not existing.
 * It re-checks the same {@link proven} rule its callers filtered by, so the
 * two can never drift into disagreeing.
 */
async function removeOne(
  deps: ForwardedRouteDependencies,
  owner: RouteOwnership,
  carried: CarriedRoute
): Promise<void> {
  const prefix = carried.prefix;
  if (!ILP_ADDRESS.test(prefix) || !proven(owner, carried)) {
    throw new ForwardedRouteError(
      'hub',
      `this hub will not remove ${prefix}: it is neither an address beneath ${owner.grantedPrefix} nor a row forwarding to ${owner.localLabel ?? '(no label offered)'}`,
      prefix
    );
  }

  const { policy, signer } = deps;
  const target = new URL(
    `${policy.operatorUrl}${ROUTES_WRITE_PATH}/${encodeURIComponent(prefix)}`
  );
  // A DELETE carries no body, and the digest of no body is still what binds
  // the signature to the request the verifier reconstructs.
  const body = '';

  let lastError: ForwardedRouteError | undefined;

  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 500);
    }

    const signature = await signer.sign('DELETE', target.pathname, body);

    let response: Response;
    try {
      response = await fetch(target, {
        method: 'DELETE',
        headers: {
          'signature-input': signature['signature-input'],
          signature: signature.signature,
          'content-digest': signature['content-digest'],
        },
        signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = new ForwardedRouteError(
        'hub',
        "the hub's own operator surface could not be reached",
        prefix,
        error instanceof Error ? error.message : String(error)
      );
      continue;
    }

    const said = await response.text();

    // Gone, or already gone. Both are the state this was asking for, and a
    // retry that finds its predecessor's work done is not a failure.
    if (response.ok || response.status === 404) return;

    if (response.status === 409) {
      throw new ForwardedRouteError(
        'config',
        `the hub's own configuration file already owns the route for ${prefix}`,
        prefix,
        said.trim()
      );
    }

    if (response.status < 500) {
      throw new ForwardedRouteError(
        'hub',
        `the hub's operator surface refused to remove the route for ${prefix} with ${String(response.status)}`,
        prefix,
        said.trim()
      );
    }

    lastError = new ForwardedRouteError(
      'hub',
      `the hub's operator surface answered ${String(response.status)} removing ${prefix}`,
      prefix,
      said.trim()
    );
  }

  throw (
    lastError ??
    new ForwardedRouteError(
      'hub',
      `the route for ${prefix} was never removed`,
      prefix
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

/**
 * Whether this row is provably the owner's, by either of the two proofs
 * {@link RouteOwnership} names. One function so that the filter a caller
 * applies and the fence {@link removeOne} re-checks are the same rule rather
 * than two spellings of it that can drift apart.
 */
function proven(owner: RouteOwnership, carried: CarriedRoute): boolean {
  if (beneath(carried.prefix, owner.grantedPrefix)) return true;
  return (
    owner.localLabel !== undefined &&
    owner.localLabel !== '' &&
    carried.peerId === owner.localLabel
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, ms));
}
