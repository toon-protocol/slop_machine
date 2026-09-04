/**
 * The hub's admission policy: what a slot costs, how long it lasts, how many
 * exist at once, and the address they are granted beneath.
 *
 * All four are **configuration a hub operator sets**, never constants. That is
 * the whole point of this module: admission here is a price rather than a
 * judgement, so the only levers a hub operator has over who gets in are these
 * numbers, and changing one must not be a code change. A hub that wants to
 * stop admitting anybody sets its cap to zero; a hub that wants a shorter
 * period writes a shorter one.
 *
 * **None of this is payment code and none of it prices a route.** Pricing a
 * route is connector configuration and lives in the hub's `connector.toml`.
 * What `slotPrice` is, here, is the number the app *reports* at the quote
 * address so a broadcaster learns what the buy will cost before they make it —
 * and, from the buy onward, the floor the app checks the connector's own
 * stated `X-TOON-Amount` against, so a route misconfigured to under-charge
 * cannot sell slots below the operator's policy. Reading a fact the connector
 * stated is not validating a payment.
 *
 * **`TOON_SLOT_PRICE` and the hub's connector route are one pair**, the same
 * way the station's `TOON_RUNGS` and its routes are: the price written here
 * and the price the connector charges at the buy address are two spellings of
 * one number, and they change in the same commit.
 *
 * Every value is validated **fail-closed at boot**, before anything binds —
 * the same posture the origin takes with its ladder and its retention window.
 * A hub whose policy cannot be read must look broken rather than admit
 * broadcasters on a number nobody chose.
 *
 * @module
 */

/**
 * The hub's own ILP address — what a granted prefix is built beneath
 * (env: `TOON_HUB_ADDRESS`).
 *
 * The default is the fleet's demo hub, which is the address
 * `deploy/connector.toml` already prices five station routes beneath. A real
 * hub operator sets their own, because the prefix they grant has to be an
 * address their own connector actually terminates.
 */
export const DEFAULT_HUB_ADDRESS = 'g.toon.slopmachine';

/**
 * What a slot costs for one period, in the settlement token's smallest unit
 * (env: `TOON_SLOT_PRICE`).
 *
 * A placeholder like every other number in this repo, from
 * [`docs/placeholder-numbers.md`](../../../../docs/placeholder-numbers.md):
 * about a dollar. Deliberately cheap — the slot exists to make admission
 * self-service and to lapse dead stations, not to be revenue. Carriage is
 * where a hub earns.
 */
export const DEFAULT_SLOT_PRICE = 1_000_000;

/**
 * How long one purchase lasts, in seconds (env: `TOON_SLOT_PERIOD_SECONDS`).
 *
 * Thirty days. Seconds rather than days because the unit is what makes the
 * lapse testable: the suite sets a period of a second or two and watches a
 * slot lapse for real, rather than reaching for a fake clock. Exactly the
 * precedent `--ingest-idle-seconds` set on the station side, where a time rule
 * was made ordinary configuration instead of an injected clock.
 */
export const DEFAULT_SLOT_PERIOD_SECONDS = 30 * 24 * 60 * 60;

/**
 * How many slots may be held at once (env: `TOON_SLOT_CAP`).
 *
 * This is the hub's **capital** bound, not a performance one. Every admission
 * opens a payment channel the hub fronts collateral toward, so the roster is a
 * balance-sheet commitment that grows linearly with its own size, and the cap
 * is the only thing bounding it. A hub operator picks the number their
 * collateral can carry.
 *
 * **Zero is legal and means "admitting nobody"** — a hub that is full, or
 * closed, or not yet funded. It is a policy an operator may want to state, and
 * it must be reachable by configuration rather than by taking the app down:
 * the quote still answers, and answers honestly that there is no capacity.
 */
export const DEFAULT_SLOT_CAP = 100;

/** An admission policy the hub will not run with. */
export class SlotPolicyError extends Error {
  override readonly name = 'SlotPolicyError';
}

/** What a hub operator sets, resolved and checked. */
export interface SlotPolicy {
  /** The hub's own ILP address. A granted prefix sits directly beneath it. */
  hubAddress: string;
  /** What a slot costs for one period, in the token's smallest unit. */
  slotPrice: number;
  /** How long one purchase lasts, in seconds. */
  slotPeriodSeconds: number;
  /** How many slots may be held at once. Zero admits nobody. */
  slotCap: number;
}

/** The same four, as a caller may leave them for their defaults. */
export interface SlotPolicyConfig {
  hubAddress?: string | undefined;
  slotPrice?: number | string | undefined;
  slotPeriodSeconds?: number | string | undefined;
  slotCap?: number | string | undefined;
}

/**
 * An ILP address: dot-separated segments of the characters an address allows.
 *
 * Checked because the hub address is not decoration — it is the left-hand side
 * of every prefix this app grants, and a granted prefix that is not a valid
 * ILP address is a broadcaster who writes an unaddressable label into their
 * own `connector.toml` and finds out at the first packet.
 */
const ILP_ADDRESS = /^[a-zA-Z0-9_~-]+(\.[a-zA-Z0-9_~-]+)*$/;

/**
 * Resolve the hub's admission policy, applying defaults, or refuse naming what
 * is wrong.
 *
 * @throws SlotPolicyError naming the setting and what was configured. A bad
 * policy is a refuse-to-start, never a degraded run.
 */
export function resolveSlotPolicy(config: SlotPolicyConfig = {}): SlotPolicy {
  const hubAddress = (config.hubAddress ?? DEFAULT_HUB_ADDRESS).trim();
  if (!ILP_ADDRESS.test(hubAddress)) {
    throw new SlotPolicyError(
      `the hub address must be an ILP address — dot-separated segments of letters, digits, "_", "~" and "-" — not ${JSON.stringify(hubAddress)}`
    );
  }

  return {
    hubAddress,
    // A price of zero is refused rather than treated as "free": the connector
    // states no attribution headers at all on a zero-priced route, so a slot
    // app in front of one could never read a payer and would refuse every
    // caller. A hub that wants to give slots away has no way to do it here.
    slotPrice: whole(config.slotPrice, DEFAULT_SLOT_PRICE, {
      what: 'slot price',
      env: 'TOON_SLOT_PRICE',
      min: 1,
    }),
    slotPeriodSeconds: whole(
      config.slotPeriodSeconds,
      DEFAULT_SLOT_PERIOD_SECONDS,
      { what: 'slot period', env: 'TOON_SLOT_PERIOD_SECONDS', min: 1 }
    ),
    // Zero is a policy, not a mistake: a hub that admits nobody.
    slotCap: whole(config.slotCap, DEFAULT_SLOT_CAP, {
      what: 'slot cap',
      env: 'TOON_SLOT_CAP',
      min: 0,
    }),
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
    throw new SlotPolicyError(
      `the ${setting.what} (${setting.env}) must be a whole number of at least ${String(setting.min)}, not ${JSON.stringify(value)}`
    );
  }
  return resolved;
}

/** The policy as one line an operator can check at boot. */
export function describeSlotPolicy(policy: SlotPolicy): string {
  const days = policy.slotPeriodSeconds / 86_400;
  return (
    `slots beneath ${policy.hubAddress} at ${String(policy.slotPrice)} ` +
    `for ${String(policy.slotPeriodSeconds)}s (about ${days.toFixed(1)} day(s)), ` +
    `cap ${String(policy.slotCap)}`
  );
}
