/**
 * The handle: the label a hub grants a broadcaster, derived from the payer the
 * connector verified.
 *
 * **A broadcaster does not choose their handle, and that is the design rather
 * than an oversight.** A hub sits in front of an address space it is
 * responsible for, and the only identity in a paid request that is not
 * self-asserted is the one the connector states: `X-TOON-Payer`, the client
 * channel key whose covering claim it admitted at its own edge, and only where
 * it verified that claim itself
 * ([connector ADR 0040](https://github.com/toon-protocol/connector/blob/main/docs/adr/0040-a-verified-payment-is-stated-to-the-app.md)).
 * Binding the label to that key buys three things at once:
 *
 *   - **The same broadcaster gets the same handle, for ever.** The address on
 *     their broadcaster page keeps working, and a repeat purchase is a renewal
 *     rather than a second station at a second address.
 *   - **Nobody else can take it.** A handle is not a name in a registry that a
 *     faster payer could claim; it is a function of a key only its holder can
 *     pay with.
 *   - **There is no "that handle is taken" refusal.** That matters far more
 *     than it looks — see ADR 0003's amendment. The connector fulfills on any
 *     complete answer from an app whatever its status, so a refusal at the buy
 *     address is a refusal the broadcaster *paid the slot price for*. A vanity
 *     handle would put a foreseeable refusal at the most expensive address in
 *     the design. Deriving the handle deletes that case instead of pricing it.
 *
 * The cost is that a broadcaster gets no vanity handle. That is accepted, and
 * it is the trade the paid-refusal problem is worth making.
 *
 * **How a collision is handled: by lengthening, never by refusing.** Twelve
 * hex characters is 48 bits, so two hub-mates colliding is a coin-flip event
 * somewhere past a million admitted stations — but "vanishingly unlikely" is
 * not "impossible", and the one behaviour this module must never have is
 * turning one broadcaster away because another broadcaster's key hashed
 * nearby. So a taken label is lengthened, deterministically, along the same
 * digest: twelve characters, then sixteen, then twenty, out to the full
 * sixty-four. Both callers are admitted, both keep a stable handle, and the
 * lengthening is a pure function of the digest and of what the roster already
 * holds.
 *
 * @module
 */

import { createHash } from 'node:crypto';

/**
 * The header a terminating connector states the verified payer in.
 *
 * Read in lower case because that is how HTTP header names compare; what
 * arrives on the wire is `X-TOON-Payer`.
 */
export const PAYER_HEADER = 'x-toon-payer';

/**
 * How many hex characters a handle label starts at.
 *
 * Twelve — 48 bits — is chosen from both ends. Short enough that a
 * broadcaster can type it into their own `connector.toml` and read it back off
 * a broadcaster page without transcribing a paragraph, and long enough that
 * the collision path below is exercised by tests rather than by hubs.
 */
export const HANDLE_LABEL_HEX_LENGTH = 12;

/** How much longer each successive candidate is. */
const HANDLE_LABEL_HEX_STEP = 4;

/**
 * The longest a label can get by lengthening: the whole SHA-256 digest.
 *
 * Past this there is nothing left of the digest to add, so two payers still
 * colliding would have to share a SHA-256 output.
 */
const HANDLE_LABEL_HEX_MAX = 64;

/**
 * How many further candidates are tried past the full digest before the
 * derivation gives up.
 *
 * Reaching even the first of them requires a SHA-256 collision, so this bound
 * exists to keep the loop finite rather than because anything is expected to
 * use it. It is deliberately not "refuse the caller": the suffixed candidates
 * are there so that a collision no cryptographer has produced would still
 * admit both broadcasters.
 */
const HANDLE_LABEL_SUFFIX_LIMIT = 1000;

/** A handle that could not be derived. Requires a SHA-256 collision to reach. */
export class HandleDerivationError extends Error {
  override readonly name = 'HandleDerivationError';
}

/**
 * The verified payer key from a request's headers, or `undefined` when the
 * request did not arrive through a paid termination this connector verified.
 *
 * **`undefined` is not "the caller forgot a header".** A caller's own spelling
 * of `X-TOON-Payer` never survives the connector's strip, which runs
 * unconditionally and ahead of the injection — so an app reading this header
 * is reading its own connector or reading nothing. Absent therefore means one
 * of: the packet crossed the peer wire rather than terminating here, no client
 * claim covered it, or the route it arrived on is priced at zero. All three
 * are facts about how the hub is wired, and none of them is about the caller.
 *
 * The value is used exactly as it was stated, trimmed of the whitespace an
 * HTTP header may carry and nothing else. The connector states it in one
 * canonical form already (`evm:0x<64 lower-case hex>`, `solana:<base58>`), and
 * a canonicalisation of our own would be this app second-guessing the only
 * fact in the request it did not have to trust — and would risk mapping one
 * broadcaster onto two handles the day the two spellings disagreed.
 */
export function readPayerKey(
  header: string | null | undefined
): string | undefined {
  if (header === null || header === undefined) return undefined;
  const payerKey = header.trim();
  return payerKey === '' ? undefined : payerKey;
}

/**
 * Derive the label a payer's handle is, given what the roster already holds.
 *
 * Deterministic in both its arguments: the same payer key against the same
 * roster produces the same label, every time and for ever. It never refuses.
 *
 * @param payerKey - the verified payer key, as the connector stated it.
 * @param isTaken - whether a candidate label is already held by somebody. A
 * label this payer holds themselves is **not** taken — a renewal derives the
 * handle it already has — but that case never reaches here, because a payer
 * who is on the roster is read off it rather than derived for.
 * @throws HandleDerivationError only where the digest and a thousand suffixes
 * are all taken, which requires a SHA-256 collision.
 */
export function deriveHandleLabel(
  payerKey: string,
  isTaken: (label: string) => boolean
): string {
  const digest = createHash('sha256').update(payerKey, 'utf8').digest('hex');

  // Lengthen along the digest first. Each candidate contains the last, so a
  // broadcaster whose handle grew still reads as the same derivation.
  for (
    let length = HANDLE_LABEL_HEX_LENGTH;
    length <= HANDLE_LABEL_HEX_MAX;
    length += HANDLE_LABEL_HEX_STEP
  ) {
    const label = digest.slice(0, length);
    if (!isTaken(label)) return label;
  }

  // Past the whole digest. Unreachable without a SHA-256 collision, and here
  // only so that such a collision would still admit the second broadcaster
  // rather than turning them away at a paid address.
  for (let suffix = 1; suffix <= HANDLE_LABEL_SUFFIX_LIMIT; suffix += 1) {
    const label = `${digest}-${String(suffix)}`;
    if (!isTaken(label)) return label;
  }

  throw new HandleDerivationError(
    'every candidate label for this payer is already held, which requires a SHA-256 collision'
  );
}

/**
 * The prefix a label is granted at: the hub's own address, then the label.
 *
 * This is the address a broadcaster writes into their own station's
 * `connector.toml` before they buy, and everything their station sells sits
 * beneath it — one segment per thing, one route per segment.
 */
export function grantedPrefix(hubAddress: string, label: string): string {
  return `${hubAddress}.${label}`;
}

/**
 * The shape of every label this derivation can produce, and of no other.
 *
 * Twelve lower-case hex characters, lengthened four at a time to the sixty-four
 * of a whole SHA-256 digest, with the suffixed form a digest collision would
 * reach. Nothing else is a label this hub granted.
 */
const HANDLE_LABEL = /^[0-9a-f]{12}(?:[0-9a-f]{4}){0,13}(?:-[0-9]{1,4})?$/;

/**
 * Whether `label` is one this hub could have derived and granted.
 *
 * **This is a fence, and the reason it is in this module rather than in the
 * code that uses it.** The one thing a hub reconciles against its own
 * connector at boot is an address space *it hands out*, and every address in
 * that space is the hub's own address followed by a label {@link
 * deriveHandleLabel} produced. A hub operator's own hand-written peering, or
 * one their config file owns, cannot be mistaken for one of them: `apex-relay`
 * is not a digest, and nothing here will ever say it is.
 *
 * It answers about a *shape*, never about who holds what — the roster answers
 * that, and both questions have to be asked before anything is removed.
 */
export function isHandleLabel(label: string): boolean {
  return HANDLE_LABEL.test(label);
}

/**
 * The label a prefix sits beneath, where that prefix is inside the address
 * space this hub grants — `undefined` otherwise.
 *
 * `g.hub.abcdef012345.now` beneath `g.hub` is `abcdef012345`. `g.hub.demo` is
 * nothing: `demo` is not a label this hub derives, so the row is somebody
 * else's — an operator's own reservation, most likely — and this hub has no
 * business acting on it. So is anything outside the hub's address entirely.
 */
export function grantedLabelIn(
  hubAddress: string,
  prefix: string
): string | undefined {
  if (!prefix.startsWith(`${hubAddress}.`)) return undefined;
  const label = prefix.slice(hubAddress.length + 1).split('.')[0] ?? '';
  return isHandleLabel(label) ? label : undefined;
}
