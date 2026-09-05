/**
 * The **collateral**: the hub's own money, put behind the peering it has just
 * established.
 *
 * Establishing a peering **opens** a payment channel; it does not fund one
 * (connector ADR 0058, and `POST /channels/:id/fund` — ADR 0008's third
 * write). Those are two acts and the second one is this module. Without it a
 * broadcaster who paid the slot price is peered, routed, on the roster,
 * visible in the quote, and carries nothing: the hub's own connector refuses
 * to sign a covering claim for a packet it was about to forward and answers
 * `T00` — *"channel … has 0 base units of headroom left"* — naming the hub's
 * own internal state rather than the deposit nobody made, so the one person
 * who could fix it learns nothing from the failure.
 *
 * So the buy funds the channel it opened, and the fulfill means **peered and
 * payable** rather than merely peered.
 *
 * ## The write is an increment, so it is made idempotent by reading first
 *
 * `POST /channels/:id/fund` takes an **amount to add**, not a total to reach.
 * That makes it the one write in this app where repeating it spends real
 * money — a broadcaster's retry, a renewal every period, a boot that repeats
 * what the previous process just did. So nothing here ever sends the
 * configured figure: it reads what the hub's own side of the channel already
 * holds over the bearer-gated `GET /channels`, and deposits **only the
 * shortfall**. A channel already holding what the policy fronts is left
 * alone, with no write at all.
 *
 * The fleet's only other caller of this endpoint solves it the same way and
 * says so: `connector/local/open-solana-channel.py` reads the payer's own
 * deposit off the chain before topping it up, precisely because
 * `FundChannelRequest` takes an increment where the EVM leg's
 * `setTotalDeposit` takes a total. The shortfall rule is what makes the two
 * behave alike, and it is what makes a renewal a **top-up** rather than a
 * second deposit — a long-lived station stays payable without the hub's
 * capital growing every period.
 *
 * **A retry re-reads rather than re-sends.** A funding write that timed out
 * may or may not have landed, and re-sending the same amount blind is how a
 * hub deposits twice for one admission. So each attempt starts by reading the
 * channel again: a deposit that did land makes the shortfall zero and the
 * retry deposits nothing, and one that did not is simply made.
 *
 * ## Whose fault a failure is
 *
 * Always the hub's. The station is not consulted, the request named nothing
 * that reaches here, and every way this can fail is the hub's own operator
 * surface, its own settlement backend, or its own chain. {@link
 * ChannelFundingError} therefore carries no `failure` side the way
 * `PeeringError` does — there is only one — and the buy's refusal says so, so
 * that a broadcaster does not go looking at their own connector.
 *
 * **A failure leaves the peering standing.** Nothing here rolls one back:
 * the channel is open, the retry finds it (`"status": "found"`) rather than
 * opening a second one, and the deposit the retry makes is the shortfall
 * against whatever actually landed. A rollback would spend gas to destroy the
 * thing a retry needs.
 *
 * @module
 */

import type { WriteSigner } from '../operator/write-signature.js';

/** Where the channels this hub holds are read. Bearer-gated, like every read. */
const CHANNELS_READ_PATH = '/channels';

/** How many times one funding write is attempted before it is given up on. */
const WRITE_ATTEMPTS = 3;

/** How long to wait before the nth retry, in milliseconds. */
const RETRY_BACKOFF_MS = [200, 500];

/** How long to wait for the operator surface, in milliseconds. */
const WRITE_TIMEOUT_MS = 20_000;

/** How long to wait for a read of the hub's own channels, in milliseconds. */
const READ_TIMEOUT_MS = 10_000;

/**
 * A channel identifier, as the operator surface will accept one in a path.
 *
 * Checked before an identifier is ever put in a URL. It is read off an answer
 * from the hub's own connector rather than composed here, and one carrying a
 * `/` or a `..` would be a `POST` aimed at a path nobody named.
 */
const CHANNEL_ID = /^[a-zA-Z0-9_.:~-]+$/;

/**
 * The hub's collateral could not be put behind the peering.
 *
 * Always about the hub's own node — see this module's header — which is why
 * there is no side to name here.
 */
export class ChannelFundingError extends Error {
  override readonly name = 'ChannelFundingError';
  /** What the operator surface said, where it said anything. */
  readonly detail: string;
  /**
   * Whether asking again could answer differently.
   *
   * A connector still coming up, a chain that outran the budget, a channel
   * the surface has not caught up with: worth another attempt, and the
   * attempt starts by reading the channel again rather than by re-sending.
   * A refused write key or a deposit this app cannot read says the same thing
   * however many times it is asked.
   */
  readonly transient: boolean;

  constructor(message: string, detail = '', transient = false) {
    super(message);
    this.detail = detail;
    this.transient = transient;
  }
}

/** What the hub's side of a channel holds once the funding is done. */
export interface FundedChannel {
  /** The channel the collateral sits in. */
  channelId: string;
  /**
   * What the hub's own side of it holds now, in the settlement token's
   * smallest unit — the policy figure, once this has resolved.
   */
  held: bigint;
  /**
   * What **this** call deposited: the shortfall it found, or `0n` where the
   * channel already held what the hub fronts.
   *
   * `0n` is the ordinary answer to a retry and to a renewal, and it is the
   * thing that makes either of them safe.
   */
  deposited: bigint;
}

/** What funding a channel needs. */
export interface ChannelFundingDependencies {
  /** Where the hub's operator surface is, and what it fronts per peering. */
  policy: {
    operatorUrl: string;
    /** What the hub puts behind one peering. Its own policy, never a caller's. */
    collateral: number;
  };
  /** The signer for the mounted operator write key. A deposit is a write. */
  signer: WriteSigner;
  /** The mounted operator bearer token. Read-gating only, never a write. */
  bearerToken: string;
}

/** Which channel to put the hub's collateral behind. */
export interface ChannelFundingRequest {
  /**
   * The channel the peering write named — read back off the hub's own
   * connector, never composed here and never anything a caller sent.
   */
  channelId: string;
}

/**
 * Put the hub's collateral behind this channel, depositing only what is
 * missing.
 *
 * Resolves once the hub's own side of the channel holds what the policy
 * fronts — including immediately, with no write at all, where it already did.
 *
 * @throws ChannelFundingError naming the hub's own node. The peering is left
 * standing for a retry to reuse.
 */
export async function fundChannel(
  deps: ChannelFundingDependencies,
  request: ChannelFundingRequest
): Promise<FundedChannel> {
  const { channelId } = request;
  if (!CHANNEL_ID.test(channelId)) {
    throw new ChannelFundingError(
      `this hub will not fund ${channelId}: its own connector named a channel this app cannot address`
    );
  }

  const fronted = BigInt(deps.policy.collateral);
  let lastError: ChannelFundingError | undefined;

  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 500);
    }

    // THE READ COMES FIRST, ON EVERY ATTEMPT. The write is an increment, so a
    // retry that re-sent the amount it sent last time would deposit twice for
    // one admission whenever the first write landed and its answer did not.
    // Reading again turns that case into a shortfall of zero.
    let held: bigint;
    try {
      held = await ownDeposit(deps, channelId);
    } catch (error) {
      if (error instanceof ChannelFundingError && error.transient) {
        lastError = error;
        continue;
      }
      throw error;
    }

    const shortfall = fronted - held;
    // Already funded — a retry, a renewal, or a hub whose operator topped the
    // channel up by hand. Nothing to write, and writing anyway is the whole
    // failure this module exists to avoid.
    if (shortfall <= 0n) {
      return { channelId, held, deposited: 0n };
    }

    try {
      await deposit(deps, channelId, shortfall);
    } catch (error) {
      if (error instanceof ChannelFundingError && error.transient) {
        lastError = error;
        continue;
      }
      throw error;
    }

    return { channelId, held: held + shortfall, deposited: shortfall };
  }

  throw (
    lastError ??
    new ChannelFundingError(
      `this hub never put its collateral behind ${channelId}`
    )
  );
}

/**
 * What the hub's own side of this channel already holds.
 *
 * `own_deposited` is the collateral backing claims **this** node signs, which
 * is exactly what a forwarded packet spends and exactly what
 * `POST /channels/:id/fund` raises (connector issue #1118). `deposited` is the
 * counterparty's own side and is none of this app's business.
 */
async function ownDeposit(
  deps: ChannelFundingDependencies,
  channelId: string
): Promise<bigint> {
  const target = new URL(`${deps.policy.operatorUrl}${CHANNELS_READ_PATH}`);

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
    throw new ChannelFundingError(
      "the hub's own operator surface could not be reached",
      error instanceof Error ? error.message : String(error),
      true
    );
  }

  const said = await response.text();
  if (!response.ok) {
    throw new ChannelFundingError(
      `the hub's operator surface answered ${String(response.status)} when asked what its channels hold`,
      said.trim(),
      // 401 is the bearer token, which is the hub operator's mount to fix.
      response.status >= 500
    );
  }

  return readOwnDeposit(said, channelId);
}

/**
 * The hub's own deposit on one channel, out of the answer to `GET /channels`.
 *
 * Fail-closed, unlike the two table reads beside it. Those ignore a row they
 * cannot read because the safe direction there is to act on fewer rows; here
 * the number *is* the decision, and a figure this app misread is a deposit of
 * the wrong size. A channel the hub's own connector does not report at all is
 * the same kind of refusal: the peering write named it a moment ago, so a
 * connector that no longer knows it is a connector nothing may be concluded
 * from.
 */
function readOwnDeposit(said: string, channelId: string): bigint {
  let answered: unknown;
  try {
    answered = JSON.parse(said);
  } catch {
    throw new ChannelFundingError(
      "the hub's operator surface answered something that is not JSON when asked what its channels hold"
    );
  }
  if (!Array.isArray(answered)) {
    throw new ChannelFundingError(
      "the hub's operator surface answered something that is not a table of channels"
    );
  }

  for (const entry of answered) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, own_deposited: own } = entry as Record<string, unknown>;
    if (id !== channelId) continue;

    // A deposit is a `u128` of base units and this reader will not guess at
    // one it cannot hold exactly: past 2^53 a JSON number is no longer the
    // integer it was written as, and a shortfall computed from a rounded
    // figure is a deposit of the wrong size. The hub's own collateral is a
    // safe integer by policy, so anything beyond it is a channel this app
    // must not reason about rather than one it quietly gets wrong.
    if (typeof own !== 'number' || !Number.isSafeInteger(own) || own < 0) {
      throw new ChannelFundingError(
        `the hub's operator surface reported a deposit on ${channelId} that this app cannot read exactly`,
        JSON.stringify(own)
      );
    }
    return BigInt(own);
  }

  throw new ChannelFundingError(
    `the hub's own connector does not report the channel ${channelId} it named a moment ago`,
    '',
    // Worth asking again: a channel opened a moment ago that a surface has
    // not caught up with is the one reading of this that a retry can fix.
    true
  );
}

/** Deposit exactly `amount` into the hub's own side of this channel. */
async function deposit(
  deps: ChannelFundingDependencies,
  channelId: string,
  amount: bigint
): Promise<void> {
  const target = new URL(
    `${deps.policy.operatorUrl}${CHANNELS_READ_PATH}/${encodeURIComponent(channelId)}/fund`
  );
  // Written by hand rather than through `JSON.stringify`, because an amount is
  // a `u128` of base units held here as a `bigint`, and the surface expects
  // the integer a config file would spell.
  const body = `{"amount":${amount.toString()}}`;

  // A fresh signature, never a re-sent one: an accepted signature is spent,
  // and the loop above asks again rather than repeating itself.
  const signature = await deps.signer.sign('POST', target.pathname, body);

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
    // The hub could not reach its own connector, or the deposit outran the
    // budget. Either way it is unknown whether it landed, which is precisely
    // why the retry re-reads instead of re-sending.
    throw new ChannelFundingError(
      `this hub could not reach its own operator surface to fund ${channelId}, and cannot tell whether the deposit landed`,
      error instanceof Error ? error.message : String(error),
      true
    );
  }

  const said = await response.text();
  if (response.ok) return;

  if (response.status < 500) {
    // 400 the settlement backend refusing the deposit, 401 an unallowlisted
    // write key, 404 a channel this connector does not hold. None of them
    // says anything different for being asked twice.
    throw new ChannelFundingError(
      `the hub's operator surface refused to fund ${channelId} with ${String(response.status)}`,
      said.trim()
    );
  }

  throw new ChannelFundingError(
    `the hub's operator surface answered ${String(response.status)} funding ${channelId}`,
    said.trim(),
    true
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, ms));
}
