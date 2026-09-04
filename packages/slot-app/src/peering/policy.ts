/**
 * The hub's **peering** policy: where its operator surface is, what it
 * charges to carry a packet to a broadcaster it admitted, and how large a
 * packet it will carry.
 *
 * Kept apart from `../slot/policy.ts` on purpose. That module is the hub's
 * **admission** policy — what a *slot* costs, how long one lasts, how many
 * exist. This one is about the *peering* the operator key creates in
 * response to a purchase. A slot is not a peering (ADR 0003), and the two
 * policies do not share a module any more than they share a word.
 *
 * **A broadcaster does not choose how far the hub trusts them.** The fee and
 * the packet cap are the hub operator's own numbers about a counterparty, and
 * they are in the peering write precisely because no document a broadcaster
 * serves could supply them (connector ADR 0006). Nothing a caller sends
 * reaches either of them.
 *
 * @module
 */

/** A peering policy the hub will not run with. */
export class PeeringPolicyError extends Error {
  override readonly name = 'PeeringPolicyError';
}

/**
 * What the hub retains for carrying one packet to a broadcaster it peered
 * with, in the settlement token's smallest unit (env: `TOON_PEERING_FEE`).
 *
 * A placeholder like every other number in this repo. Carriage is where a hub
 * earns — the slot price exists to make admission self-service and to lapse
 * dead stations, not to be revenue — and it is what has to cover the
 * collateral every admission fronts.
 */
export const DEFAULT_PEERING_FEE = 10;

/**
 * The largest amount the hub will forward to a broadcaster in one packet
 * (env: `TOON_PEERING_MAX_PACKET_AMOUNT`).
 *
 * The connector refuses anything above it with a `T04`. It has to sit above
 * the most expensive thing a station sells, or the hub is peered with a
 * station whose top rung nobody can pay for.
 */
export const DEFAULT_PEERING_MAX_PACKET_AMOUNT = 10_000_000;

/** Where the hub's operator surface is, and the terms it peers on. */
export interface PeeringPolicy {
  /**
   * The base URL of the hub's own connector operator surface — in a hub
   * bundle, the connector container on the compose network.
   *
   * **Configuration, not an injected port.** The suite points it at a fake
   * operator surface booted in-process; production points it at the real
   * connector. The app's own API exposes no seam for either.
   */
  operatorUrl: string;
  /** What the hub retains for carrying one packet to the broadcaster. */
  fee: number;
  /** The largest amount the hub will forward in one packet. */
  maxPacketAmount: number;
}

/** The same three, as a caller may leave them for their defaults. */
export interface PeeringPolicyConfig {
  operatorUrl?: string | undefined;
  peeringFee?: number | string | undefined;
  peeringMaxPacketAmount?: number | string | undefined;
}

/**
 * Resolve the hub's peering policy, or refuse naming what is wrong.
 *
 * The operator URL has **no default and is required**, on exactly the terms
 * the two operator credentials are: an app that cannot reach an operator
 * surface can admit nobody, and a hub that can admit nobody must look broken
 * rather than look fine. A default pointing at some plausible address would
 * be worse than none — it would boot, answer liveness, pass every supervisor
 * on the box, and fail the first broadcaster who paid.
 *
 * @throws PeeringPolicyError naming the setting and what was configured.
 */
export function resolvePeeringPolicy(
  config: PeeringPolicyConfig = {}
): PeeringPolicy {
  const stated = (config.operatorUrl ?? '').trim();
  if (stated === '') {
    throw new PeeringPolicyError(
      "no operator surface configured; set TOON_OPERATOR_URL (or --operator-url) to the hub connector's own base URL, e.g. http://connector:3000. There is no default — a hub that cannot reach its operator surface can admit nobody, and must look broken rather than look fine"
    );
  }

  let operatorUrl: URL;
  try {
    operatorUrl = new URL(stated);
  } catch {
    throw new PeeringPolicyError(
      `the operator surface (TOON_OPERATOR_URL) must be an absolute URL, not ${JSON.stringify(stated)}`
    );
  }
  if (operatorUrl.protocol !== 'http:' && operatorUrl.protocol !== 'https:') {
    throw new PeeringPolicyError(
      `the operator surface (TOON_OPERATOR_URL) must be an http or https URL, not ${JSON.stringify(stated)}`
    );
  }

  return {
    // Kept without a trailing slash so a path joined onto it is the path that
    // gets signed — `@path` is a covered component, and a doubled slash is a
    // different path to the verifier than the one the request is sent to.
    operatorUrl: operatorUrl.toString().replace(/\/+$/, ''),
    // Zero is free carriage, which is a policy a hub may state.
    fee: whole(config.peeringFee, DEFAULT_PEERING_FEE, {
      what: 'peering fee',
      env: 'TOON_PEERING_FEE',
      min: 0,
    }),
    // Zero is refused rather than read as "no bound": the connector treats an
    // omitted cap as its own default, so a hub that meant "unbounded" and a
    // hub that meant "nothing" would be written the same way.
    maxPacketAmount: whole(
      config.peeringMaxPacketAmount,
      DEFAULT_PEERING_MAX_PACKET_AMOUNT,
      {
        what: 'peering packet cap',
        env: 'TOON_PEERING_MAX_PACKET_AMOUNT',
        min: 1,
      }
    ),
  };
}

/** One policy number, or a refusal naming the setting and the value. */
function whole(
  value: number | string | undefined,
  fallback: number,
  setting: { what: string; env: string; min: number }
): number {
  if (value === undefined || value === '') return fallback;

  const resolved = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < setting.min) {
    throw new PeeringPolicyError(
      `the ${setting.what} (${setting.env}) must be a whole number of at least ${String(setting.min)}, not ${JSON.stringify(value)}`
    );
  }
  return resolved;
}

/** The peering policy as one line an operator can check at boot. */
export function describePeeringPolicy(policy: PeeringPolicy): string {
  return (
    `peerings written at ${policy.operatorUrl} with fee ${String(policy.fee)} ` +
    `and a packet cap of ${String(policy.maxPacketAmount)}`
  );
}
