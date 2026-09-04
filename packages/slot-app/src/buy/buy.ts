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
 *   4. **The peering**, one `POST /peers` — see `../peering/peering.ts`.
 *   5. **The slot, recorded durably, before the answer.** Gas is spent inside
 *      a paid request here, so a purchase whose answer arrived too late must
 *      be found already done when the broadcaster retries rather than paying
 *      for the same peering twice.
 *   6. **The answer**: the granted prefix, and when the slot lapses.
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
 *   - a body with no station URL, and a station URL the hub cannot read.
 *     Both are facts about the **caller's own node or request** that are only
 *     discoverable once the purchase is made, and both say so plainly so a
 *     broadcaster fixes their connector rather than retrying into the same
 *     charge;
 *   - a delivery the hub's own wiring did not pay for or under-charged for,
 *     and an operator surface that would not take the write. All three are
 *     about the **hub**, and the message names the hub operator.
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
import type { PeeringDependencies } from '../peering/peering.js';
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
}

/** What the buy route needs to answer. */
export interface BuyDependencies extends PeeringDependencies {
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

    // 4. The peering — the hub's operator key's own act, synchronously,
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

    // 5. The slot, on disk, BEFORE the answer. This is what bounds the damage
    //    when a chain is slow enough that the broadcaster's own deadline
    //    passes before the answer arrives: their retry derives the same
    //    handle, finds the same channel, and rewrites the same row, rather
    //    than paying for a second peering.
    const lapsesAt = Date.now() + slotPolicy.slotPeriodSeconds * 1000;
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
      `[slot-app] slot at ${grantedPrefix(slotPolicy.hubAddress, label)} lapses at ${new Date(lapsesAt).toISOString()}; peering ${label} ${peering.channel.status} a ${peering.channel.chain} channel`
    );

    // 6. The answer.
    const bought: BoughtSlot = {
      prefix: grantedPrefix(slotPolicy.hubAddress, label),
      label,
      hubAddress: slotPolicy.hubAddress,
      lapsesAt,
      slotPeriodSeconds: slotPolicy.slotPeriodSeconds,
      peering: {
        localLabel: peering.localLabel,
        channel: peering.channel,
      },
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
        `${error.message}. This is about YOUR node, not this hub's: the URL in the purchase has to be your connector's self-description — its own base URL with /ilp on the end — reachable from the internet, published over a settlement chain this hub shares, and answering without a redirect. The hub's connector said: ${error.detail || '(nothing)'}. No peering was established, and retrying before your connector is fixed will cost the slot price again.`
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
