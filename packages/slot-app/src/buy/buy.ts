/**
 * The buy: a broadcaster pays the slot price, and the hub peers with them
 * before it answers.
 *
 * ```
 * POST /buy    {"stationUrl": "https://station.example/ilp"}
 * ```
 *
 * **The fulfill means you are peered.** Everything below happens
 * synchronously, inside the paid request, and the answer is the outcome
 * rather than a receipt for one — which is precisely what keeps this design
 * out of the shape connector ADR 0043 refused, where a purchase bought a
 * promise and a status surface had to exist for the buyer to learn what
 * became of it.
 *
 * In order, and the order is the design:
 *
 *   1. **The payer.** `X-TOON-Payer` absent means the request did not arrive
 *      through a paid termination this connector verified, and it is refused
 *      **before the operator surface is touched at all** — a misconfigured
 *      hub must not hand out free peerings.
 *   2. **The stated amount.** `X-TOON-Amount` is read against the hub's own
 *      slot price. This is **not payment validation** — it is reading a fact
 *      the connector stated, having verified it — and it exists so that a
 *      route misconfigured to under-charge cannot sell slots below the
 *      operator's policy. Refused before any operator write.
 *   3. **The handle**, derived from the payer, or read off the roster where
 *      this payer already holds a slot. The same derivation the quote makes,
 *      asked of the same roster, so the prefix a broadcaster configured their
 *      station for is the prefix they are peered at.
 *   4. **The station's own self-description**, read at the URL the purchase
 *      carried. It publishes that node's ILP addresses and **its route
 *      prices**, which is the whole price list the hub needs — taken from the
 *      station's own configuration rather than declared by the buyer, so
 *      nothing is declared and nothing can drift. Read **before** the peering
 *      write, because a station this hub cannot read is a refusal that should
 *      cost neither party a channel.
 *   5. **The routes, derived**, one per published prefix beneath the granted
 *      one, each priced at the station's own price plus the hub's carriage —
 *      see `../peering/routes.ts` for why that number is derived rather than
 *      guessed. Derived before the peering too, so a station that publishes
 *      nothing at its granted prefix is refused before the operator surface
 *      is touched at all.
 *   6. **The peering**, one `POST /peers` — see `../peering/peering.ts`.
 *   7. **The routes, written**, one `POST /routes/peers` each. Being peered
 *      is not yet being reachable: a hub carries only what its routing table
 *      names.
 *   8. **The routes the station has stopped publishing, taken back out**, one
 *      `DELETE /routes/peers/:prefix` each and only ever beneath the prefix
 *      this caller was granted. A write is an upsert, so nothing about step 7
 *      removes a rung a broadcaster dropped, and a row left behind is an
 *      address the hub carries toward a node that no longer terminates it.
 *   9. **The slot, recorded durably, before the answer.** Gas is spent inside
 *      a paid request here, so a purchase whose answer arrived too late must
 *      be found already done when the broadcaster retries rather than paying
 *      for the same peering twice.
 *  10. **The answer**: the granted prefix, the routes written, and when the
 *      slot lapses.
 *
 * **Buying again is renewing, and there is no second call to learn.** A
 * purchase by a payer who already holds a slot walks exactly the steps above:
 * the handle is read off the roster rather than derived again, so the prefix
 * a broadcaster printed on their page is the prefix they keep; the peering
 * write finds the established peering rather than opening a second channel;
 * the routes are rewritten by prefix rather than duplicated; the document is
 * read afresh, so a rung added since is routed and a rung dropped is taken
 * out; and the roster ends up holding **one** slot for that payer, never two.
 *
 * **A renewal adds a period to the slot rather than replacing it.** The new
 * lapse is measured from whichever is later — the lapse the broadcaster
 * already holds, or now:
 *
 * ```
 *   lapsesAt = max(now, the lapse already held) + the slot period
 * ```
 *
 * Measuring from *now* alone would take back the time a broadcaster had
 * already paid for, so renewing a fortnight early would cost them a
 * fortnight and the safe move would be to wait until the last minute — a hub
 * would have taught every broadcaster to renew late. Measuring from the held
 * lapse alone would do the opposite where the slot has already lapsed:
 * a station that stopped broadcasting for a month and came back would have
 * the hub's own downtime, and its own absence, credited to it. `max` is both
 * readings at once, and it is the only one that cheats nobody.
 *
 * **The request body carries only the station connector's URL.** The handle
 * comes from the payer, the fee and the packet cap from the hub's own
 * configuration, and the chain from the header the connector stated. There is
 * nothing else for a broadcaster to get wrong.
 *
 * **On refusals here, which are paid for.** ADR 0003's amendment moved every
 * foreseeable refusal to the cheap quote address, and this module holds only
 * the ones that cannot be foreseen there:
 *
 *   - a body with no station URL, a station URL the hub cannot read, and a
 *     station that publishes nothing beneath the prefix this hub granted.
 *     All three are facts about the **caller's own node or request** that are
 *     only discoverable once the purchase is made, and all three say so
 *     plainly so a broadcaster fixes their connector rather than retrying
 *     into the same charge;
 *   - a delivery the hub's own wiring did not pay for or under-charged for,
 *     an operator surface that would not take a write, and a route the hub's
 *     own config file already owns. All of them are about the **hub**, and
 *     the message names the hub operator.
 *
 * **What is deliberately *not* refused here is the cap.** A hub at its cap
 * answers that at the quote, where it costs a floor price to hear; refusing
 * it again at the buy would be charging the slot price for an answer the
 * broadcaster could already have had, which is exactly what the amendment
 * forbids.
 *
 * **No payment code lives here.** The three headers are read as facts the
 * connector stated. No claim is validated, nothing is charged, and nothing is
 * priced — the price this module compares against is a number a hub operator
 * configured.
 *
 * @module
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { establishPeering, PeeringError } from '../peering/peering.js';
import {
  deriveForwardedRoutes,
  ForwardedRouteError,
  retireForwardedRoutes,
  writeForwardedRoutes,
} from '../peering/routes.js';
import type {
  ForwardedRoute,
  ForwardedRouteDependencies,
} from '../peering/routes.js';
import { readStationDescription } from '../peering/station-description.js';
import {
  PAYER_HEADER,
  deriveHandleLabel,
  grantedPrefix,
  readPayerKey,
} from '../slot/handle.js';
import type { SlotPolicy } from '../slot/policy.js';
import {
  NO_PAID_TERMINATION,
  NO_PAID_TERMINATION_MESSAGE,
} from '../slot/refusal.js';
import type { SlotAppRefusal } from '../slot/refusal.js';
import type { SlotRoster } from '../slot/roster.js';

/**
 * The prefix the buy sits beneath — and, being the whole address, is.
 *
 * Its own connector route at the slot price, and **never the quote's**: an
 * address reachable at another address's price is a slot sold for the cost of
 * a quote, or a quote sold for the cost of a slot (connector ADR 0025).
 */
export const BUY_ROUTE_PREFIX = '/buy';

/**
 * The header a terminating connector states the amount it charged in.
 *
 * Read in lower case because that is how HTTP header names compare; what
 * arrives on the wire is `X-TOON-Amount`.
 */
export const AMOUNT_HEADER = 'x-toon-amount';

/**
 * The header a terminating connector states the chain in — the namespace of
 * the channel key whose claim it verified, `evm` or `solana`.
 *
 * This is what the peering settles on, so the hub is never guessing which of
 * two shared chains a broadcaster meant.
 */
export const CHAIN_HEADER = 'x-toon-chain';

/** The route in front of this address did not charge what a slot costs. */
export const ROUTE_UNDER_CHARGES = 'route_under_charges';

/** The request body named no station connector URL. */
export const NO_STATION_URL = 'no_station_url';

/** The station's own connector could not be read, or cannot be peered with. */
export const STATION_UNREADABLE = 'station_unreadable';

/**
 * The station's connector was read and publishes nothing beneath the prefix
 * this hub granted.
 *
 * Distinct from {@link STATION_UNREADABLE} because the remedy is: the
 * document arrived and was fine, and what is wrong is which addresses it
 * names. A broadcaster fixes it by writing the prefix their quote already
 * gave them into their own `connector.toml` and rebooting — not by making
 * their connector reachable, which it demonstrably is.
 */
export const STATION_NOT_AT_PREFIX = 'station_not_at_prefix';

/**
 * A route this purchase needed collides with a row the hub's **config file**
 * owns.
 *
 * A runtime row never shadows a config one (connector ADR 0034), so the hub
 * operator has reserved that address and this app may not take it. Nothing
 * about the caller's node is the thing to fix, and no retry can change it
 * until the hub operator changes their own configuration.
 */
export const ROUTE_OWNED_BY_CONFIG = 'route_owned_by_config';

/**
 * The hub's operator surface would not take a route write — or would not say
 * what it carries, or would not take back out a row the station has stopped
 * publishing.
 *
 * One code for all three because they are one fault with one owner: the hub's
 * own operator surface. A refusal at a paid address is paid for, so a second
 * code here would be a second way to charge a broadcaster for nothing without
 * telling them anything they could act on differently.
 */
export const ROUTES_NOT_WRITTEN = 'routes_not_written';

/** The hub's operator surface would not take the write. */
export const PEERING_NOT_ESTABLISHED = 'peering_not_established';

/**
 * The peering was established and the hub could not write the slot down.
 *
 * Not a policy refusal — a hub whose own disk failed under a paid purchase.
 * It is here rather than left as a bare `500` because what the broadcaster
 * needs to know is specific: they *are* peered, the hub cannot promise to
 * remember it, and retrying costs no second channel.
 */
export const SLOT_NOT_RECORDED = 'slot_not_recorded';

/** What a broadcaster sends. The station connector's URL, and nothing else. */
export interface BuyRequest {
  /**
   * The station connector's **self-description** URL — the document that
   * publishes the node's ILP address, its endpoints and its settlement facts
   * (connector ADR 0050). Typically the connector's own base URL with `/ilp`
   * on the end; an origin is the near-miss the hub names when it cannot read
   * one.
   */
  stationUrl: string;
}

/** The payment channel behind the peering the purchase caused. */
export interface BoughtChannel {
  /** Its on-chain identifier. */
  id: string;
  /**
   * `created` where the purchase opened it, `found` where it already existed
   * — which is what a retry of the same purchase answers, and how a
   * broadcaster (and a hub operator) can see that a retry cost no second
   * channel.
   */
  status: string;
  /** Which chain it settles on: the one the broadcaster demonstrably paid on. */
  chain: string;
}

/** The peering the hub's operator key created in response to the purchase. */
export interface BoughtPeering {
  /** The hub's own local label for it — the handle, as it was written. */
  localLabel: string;
  /** The payment channel behind it. */
  channel: BoughtChannel;
}

/** One route the hub wrote, as the broadcaster reads it back. */
export interface BoughtRoute {
  /** The ILP prefix the hub now carries toward the station. */
  prefix: string;
  /**
   * What the hub's own connector charges a viber for a packet to it: the
   * price the station's connector publishes for that address, plus the hub's
   * carriage fee.
   *
   * A **decimal string**, the same spelling the station's own document uses,
   * because a price is a `u64` of the settlement asset's base units and is
   * not representable in a JSON number a reader can be trusted with.
   */
  price: string;
  /**
   * What each started kibibyte of payload adds, where the station published a
   * slope. Absent — not `"0"` — on a flat price, which is every station route
   * the fleet runs.
   */
  pricePerKib?: string;
}

/** What a broadcaster reads once they are peered. */
export interface BoughtSlot {
  /**
   * The ILP prefix the hub granted — its own address plus the caller's label.
   * The address vibers reach the station at, and the one their own
   * `connector.toml` terminates beneath.
   */
  prefix: string;
  /** The label beneath the hub's address that makes that prefix up. */
  label: string;
  /** The hub's own ILP address, which the prefix sits directly beneath. */
  hubAddress: string;
  /**
   * When the slot lapses if it is not renewed, in milliseconds since the
   * epoch. Past this the hub takes the peering back out on its own
   * initiative.
   */
  lapsesAt: number;
  /** How long the purchase bought, in seconds. */
  slotPeriodSeconds: number;
  /**
   * The **peering** the hub's operator key created — named for what it is,
   * never for the slot that was bought (ADR 0003).
   */
  peering: BoughtPeering;
  /**
   * Every route the hub wrote, in the order it wrote them: one per address
   * the station's own connector publishes beneath the granted prefix, at that
   * address's own price plus the hub's carriage.
   *
   * This is what makes the purchase legible without a second call: a
   * broadcaster can see that every rung they sell — and their station's *now*
   * — is carried, and at what it will cost a viber to cross the hop.
   */
  routes: BoughtRoute[];
}

/** What the buy route needs to answer. */
export interface BuyDependencies extends ForwardedRouteDependencies {
  /** The hub's admission policy: price, period, cap, and its own address. */
  slotPolicy: SlotPolicy;
  /** The hub's roster — read for the handle, written before the answer. */
  roster: SlotRoster;
}

/**
 * The route that sells a slot, to be mounted at {@link BUY_ROUTE_PREFIX}.
 *
 * Answers `200` with a {@link BoughtSlot} once the peering is established and
 * the slot is on disk.
 */
export function buyRoutes(deps: BuyDependencies): Hono {
  const routes = new Hono();

  routes.post('/', async (c) => {
    // 1. The payer, before anything else and before the operator surface is
    //    touched at all. A hub whose route for this address is not charging
    //    must not be a hub that peers with whoever asks.
    const payerKey = readPayerKey(c.req.header(PAYER_HEADER));
    if (payerKey === undefined) {
      return c.json(
        refusal(NO_PAID_TERMINATION, NO_PAID_TERMINATION_MESSAGE),
        403,
        noStore()
      );
    }

    const { slotPolicy, roster } = deps;

    // 2. The stated amount against the hub's own price. Reading a fact the
    //    connector stated, not validating a payment — and refused before any
    //    operator write, so a route misconfigured to under-charge costs the
    //    hub a refusal rather than a peering it was not paid for.
    const stated = statedAmount(c.req.header(AMOUNT_HEADER));
    if (stated === undefined || stated < BigInt(slotPolicy.slotPrice)) {
      return c.json(
        refusal(
          ROUTE_UNDER_CHARGES,
          `this hub sells a slot for ${String(slotPolicy.slotPrice)}, and the connector in front of this address stated ${stated === undefined ? 'no amount' : String(stated)} for the packet that carried this purchase. Nothing here is about the request: the route the hub operator wrote for this address and the hub's own TOON_SLOT_PRICE are one pair, and they disagree. No peering was established.`
        ),
        403,
        noStore()
      );
    }

    const body = await stationUrl(c.req.raw);
    if (body === undefined) {
      return c.json(
        refusal(
          NO_STATION_URL,
          'a purchase carries one thing: {"stationUrl": "<your connector\'s self-description URL>"}, e.g. https://station.example/ilp. Everything else is derived — the handle from the payer this hub\'s connector verified, the carriage terms from the hub\'s own configuration. No peering was established.'
        ),
        400,
        noStore()
      );
    }

    // 3. The handle. A payer already on the roster is read off it rather than
    //    derived for; everybody else is derived for against the same roster
    //    the quote asked, so the prefix a broadcaster configured their
    //    station for is the prefix they get peered at.
    const held = roster.find(payerKey);
    const label =
      held?.label ??
      deriveHandleLabel(
        payerKey,
        (candidate) => roster.holderOf(candidate) !== undefined
      );

    const prefix = grantedPrefix(slotPolicy.hubAddress, label);

    // 4. The station's own self-description, read BEFORE any operator write.
    //    It publishes the addresses that node sells and what each costs, and
    //    that is the whole price list the hub uses — nothing is declared by
    //    the buyer, so nothing can drift from their real configuration. A
    //    station the hub cannot read is refused here, having cost the hub no
    //    channel and the broadcaster no orphaned peering.
    let published;
    try {
      published = await readStationDescription(body);
    } catch (error) {
      return refusePeering(c, error);
    }

    // 5. The routes, derived from that document and the hub's own carriage
    //    fee — still before any operator write, so a broadcaster who has not
    //    yet written their granted prefix into their own connector.toml is
    //    told so rather than left peered and unreachable.
    let derived;
    try {
      derived = deriveForwardedRoutes(published.routes, {
        grantedPrefix: prefix,
        fee: deps.policy.fee,
      });
    } catch (error) {
      return refuseRoutes(c, error);
    }
    if (derived.ignored.length > 0) {
      // Not a refusal: an address outside this caller's grant is not theirs
      // to be pointed at, and a hub that wrote it would be handing out
      // somebody else's address. Said out loud so a broadcaster whose rung is
      // missing from the answer can find out why from the hub's own log.
      console.warn(
        `[slot-app] ${prefix} publishes ${derived.ignored.join(', ')} outside its own prefix; not routed`
      );
    }

    // 6. The peering — the hub's operator key's own act, synchronously,
    //    before any answer goes back.
    let peering;
    try {
      peering = await establishPeering(deps, {
        localLabel: label,
        stationUrl: body,
        chain: statedChain(c.req.header(CHAIN_HEADER)),
      });
    } catch (error) {
      return refusePeering(c, error);
    }

    // 7. The routes, written. Being peered is not yet being reachable: a hub
    //    carries only what its routing table names, so this is the step that
    //    makes a viber's packet cross the hop — at every rung and at the
    //    station's own *now*.
    let written: ForwardedRoute[];
    try {
      written = await writeForwardedRoutes(deps, {
        localLabel: label,
        routes: derived.routes,
      });
    } catch (error) {
      return refuseRoutes(c, error);
    }

    // 8. The rows the station has stopped publishing, taken back out — after
    //    the writes rather than before them, so a rung is never briefly
    //    unreachable in the middle of its own broadcaster's renewal. Only
    //    ever beneath the prefix this caller was granted: a hub's routing
    //    table is shared by every broadcaster it admitted, and a runtime row
    //    carries no owner for the connector to check on this app's behalf.
    let retired: string[];
    try {
      retired = await retireForwardedRoutes(deps, {
        grantedPrefix: prefix,
        keep: derived.routes,
      });
    } catch (error) {
      return refuseRoutes(c, error);
    }

    // 9. The slot, on disk, BEFORE the answer. This is what bounds the damage
    //    when a chain is slow enough that the broadcaster's own deadline
    //    passes before the answer arrives: their retry derives the same
    //    handle, finds the same channel, and rewrites the same row, rather
    //    than paying for a second peering.
    //
    //    A purchase ADDS a period rather than replacing one, measured from
    //    the later of now and the lapse this payer already holds. Measuring
    //    from now alone would take back time a broadcaster had already paid
    //    for and teach every one of them to renew at the last minute;
    //    measuring from the held lapse alone would credit a lapsed slot with
    //    the time nobody was broadcasting. See this module's own header.
    const now = Date.now();
    const lapsesAt =
      Math.max(now, held?.lapsesAt ?? now) +
      slotPolicy.slotPeriodSeconds * 1000;
    try {
      await roster.record({ payer: payerKey, label, lapsesAt });
    } catch (error) {
      // A hub whose disk failed under a paid purchase. Said out loud rather
      // than left as a bare 500: the peering IS established, so what the
      // broadcaster needs to know is that a retry costs the hub no second
      // channel and that the hub's own data directory is the thing to fix.
      console.error(
        `[slot-app] a purchase was peered but could not be recorded: ${error instanceof Error ? error.message : String(error)}`
      );
      return c.json(
        refusal(
          SLOT_NOT_RECORDED,
          "this hub established the peering and then could not write the slot to its own data directory, so it cannot promise to remember you. Nothing about your node is the thing to fix; the hub operator's data directory is. Retrying is safe — the peering already exists, and a repeat finds the same channel rather than opening a second one."
        ),
        503,
        noStore()
      );
    }

    console.log(
      `[slot-app] slot at ${prefix} ${held === undefined ? 'bought' : 'renewed'}, lapses at ${new Date(lapsesAt).toISOString()}; peering ${label} ${peering.channel.status} a ${peering.channel.chain} channel; ${String(written.length)} route(s): ${written.map((route) => `${route.prefix} at ${route.stationPrice.toString()}+${String(deps.policy.fee)}`).join(', ')}${retired.length === 0 ? '' : `; no longer published, removed: ${retired.join(', ')}`}`
    );

    // 10. The answer.
    const bought: BoughtSlot = {
      prefix,
      label,
      hubAddress: slotPolicy.hubAddress,
      lapsesAt,
      slotPeriodSeconds: slotPolicy.slotPeriodSeconds,
      peering: {
        localLabel: peering.localLabel,
        channel: peering.channel,
      },
      routes: written.map(answered),
    };
    return c.json(bought, 200, noStore());
  });

  return routes;
}

/**
 * The amount the connector stated, or `undefined` where it stated none this
 * app can read.
 *
 * Read as a `bigint` because an amount is the settlement token's smallest
 * unit and a hub is not entitled to assume it fits a double — the comparison
 * this feeds is the only arithmetic done on it.
 */
function statedAmount(header: string | null | undefined): bigint | undefined {
  if (header === null || header === undefined) return undefined;
  const stated = header.trim();
  if (!/^\d+$/.test(stated)) return undefined;
  return BigInt(stated);
}

/**
 * The chain the connector stated, or `undefined` where it stated none.
 *
 * Passed through exactly as stated, never mapped or defaulted: the value's
 * meaning belongs to the connector at both ends of this app, and a hub that
 * invented one would be choosing which asset a peering settles in on a
 * broadcaster's behalf.
 */
function statedChain(header: string | null | undefined): string | undefined {
  if (header === null || header === undefined) return undefined;
  const stated = header.trim();
  return stated === '' ? undefined : stated;
}

/**
 * The station connector's URL out of the request body, or `undefined` where
 * the body did not carry one.
 *
 * Nothing else is read out of the body, ever. A field a broadcaster could set
 * is a term the hub did not choose.
 */
async function stationUrl(request: Request): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const stated = (parsed as { stationUrl?: unknown }).stationUrl;
  if (typeof stated !== 'string') return undefined;

  const url = stated.trim();
  if (url === '') return undefined;
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return url;
}

/**
 * What a peering that could not be established is answered with.
 *
 * The distinction that matters to a broadcaster is whose node the failure is
 * about, so it is the distinction the answer makes: a `502` names **their own
 * connector** as the thing to fix, and a `503` names the hub operator's. Both
 * cost the slot price and buy no peering — that is the honest position ADR
 * 0003's amendment settled on, and neither pretends otherwise.
 */
function refusePeering(c: Context, error: unknown): Response {
  if (error instanceof PeeringError && error.failure === 'station') {
    console.warn(
      `[slot-app] a purchase found no readable station connector: ${error.detail}`
    );
    return c.json(
      refusal(
        STATION_UNREADABLE,
        `${error.message}. This is about YOUR node, not this hub's: the URL in the purchase has to be your connector's self-description — its own base URL with /ilp on the end — reachable from the internet, published over a settlement chain this hub shares, and answering without a redirect. What the hub found when it looked: ${error.detail || '(nothing)'}. No peering was established, and retrying before your connector is fixed will cost the slot price again.`
      ),
      502,
      noStore()
    );
  }

  const detail = error instanceof PeeringError ? error.detail : '';
  console.error(
    `[slot-app] a purchase could not be peered: ${error instanceof Error ? error.message : String(error)}${detail === '' ? '' : ` — ${detail}`}`
  );
  return c.json(
    refusal(
      PEERING_NOT_ESTABLISHED,
      "this hub could not write the peering to its own connector, so nothing about your node is the thing to fix. The hub operator's own operator surface, its write-key allowlist, or its settlement chain is. No peering was established."
    ),
    503,
    noStore()
  );
}

/**
 * What a route that could not be written is answered with.
 *
 * Three answers for three different people. A station that publishes nothing
 * beneath its granted prefix is the **broadcaster's** to fix and says so, and
 * it costs no peering because the derivation happens first. A row the hub's
 * **config file** owns is the hub operator's, and it is a `409` rather than a
 * `503` because no amount of retrying changes a reserved address — only the
 * hub operator's own configuration does. Anything else is the hub's surface,
 * and is worth trying again later.
 *
 * **What a refusal here leaves behind is deliberate.** No slot is recorded,
 * so the hub never counts this caller as admitted, never lapses a slot that
 * was never sold, and answers the next quote exactly as it answered the last
 * — and a renewal refused here leaves the broadcaster holding the slot and
 * the lapse they already had, rather than a shortened one. What may survive
 * is the peering and any route written before the one that was refused —
 * both keyed by the caller's own derived label, both rewritten to the same
 * values by a retry rather than duplicated, and neither of them a slot.
 * Undoing them here would be worse than leaving them: a purchase by a
 * broadcaster who already holds a slot writes the same rows, and a rollback
 * could not tell a row it had just created from one it had merely rewritten,
 * so it would tear down a slot that is working to tidy up after one that
 * never happened.
 */
function refuseRoutes(c: Context, error: unknown): Response {
  if (error instanceof ForwardedRouteError && error.failure === 'station') {
    console.warn(
      `[slot-app] a purchase found nothing to route: ${error.message}`
    );
    return c.json(
      refusal(
        STATION_NOT_AT_PREFIX,
        `${error.message}. This is about YOUR node, not this hub's: pull a quote, take the prefix it grants you, write it into your own connector.toml as the apex of every route your station terminates — its rungs and its now — and boot before you buy. The hub read your connector fine; what it publishes is simply not addressed beneath what this hub granted you, so every packet forwarded across the hop would arrive somewhere you do not terminate. ${error.detail}. Retrying before your connector is fixed will cost the slot price again.`
      ),
      502,
      noStore()
    );
  }

  if (error instanceof ForwardedRouteError && error.failure === 'config') {
    console.error(
      `[slot-app] a purchase collided with a config-owned route: ${error.message} — ${error.detail}`
    );
    return c.json(
      refusal(
        ROUTE_OWNED_BY_CONFIG,
        `${error.message}, and a route written at runtime may never shadow one the operator's own configuration file owns. Nothing about your node is the thing to fix, and retrying will not help: the hub operator has reserved that address, and only their own configuration can release it. No slot was recorded.`
      ),
      409,
      noStore()
    );
  }

  const detail = error instanceof ForwardedRouteError ? error.detail : '';
  console.error(
    `[slot-app] a purchase could not be routed: ${error instanceof Error ? error.message : String(error)}${detail === '' ? '' : ` — ${detail}`}`
  );
  return c.json(
    refusal(
      ROUTES_NOT_WRITTEN,
      "this hub could not make its own routing table match what your station publishes — either writing a route that makes you reachable, or taking back out one you no longer sell. Nothing about your node is the thing to fix; the hub operator's own operator surface, its write-key allowlist or its bearer token is. No slot was recorded, and retrying is safe — a repeat finds the same channel rather than opening a second one."
    ),
    503,
    noStore()
  );
}

/** One written route, as the broadcaster reads it back. */
function answered(route: ForwardedRoute): BoughtRoute {
  return {
    prefix: route.prefix,
    price: route.price.toString(),
    // Absent rather than "0" on a flat price, exactly as the station's own
    // document spells it: a reader written against a flat ladder sees the
    // document it always saw.
    ...(route.pricePerKib === 0n
      ? {}
      : { pricePerKib: route.pricePerKib.toString() }),
  };
}

function refusal(error: string, message: string): SlotAppRefusal {
  return { error, message };
}

/**
 * A purchase is per-caller and happens once: the prefix is derived from *this*
 * payer, and the lapse is measured from the moment this one was recorded. A
 * cache handing one broadcaster's answer to the next would hand out the wrong
 * address and hide the fact that the second one never bought anything.
 */
function noStore(): Record<string, string> {
  return { 'cache-control': 'no-store' };
}
