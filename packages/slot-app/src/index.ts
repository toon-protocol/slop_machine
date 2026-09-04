/**
 * @toon-protocol/slot-app — the slot app.
 *
 * The hub's admission desk: a broadcaster buys a **slot** and the hub's
 * operator key creates the **peering** and the routes that make their station
 * reachable. Slot and peering are two words for two things (ADR 0003), and no
 * type, field or log line here calls one by the other's name.
 *
 * It is a plain HTTP app and contains no payment code — by the time a request
 * reaches it, the connector in front has already proven it paid.
 *
 * @module
 */

export { startSlotApp } from './slot-app/slot-app.js';
export {
  DEFAULT_SLOT_PORT,
  DEFAULT_HOST,
  DEFAULT_DATA_DIR,
  HEALTH_ROUTE_PATH,
  QUOTE_ROUTE_PREFIX,
} from './slot-app/slot-app.js';
export type {
  SlotAppConfig,
  SlotAppInstance,
  ResolvedSlotAppConfig,
} from './slot-app/slot-app.js';

// The quote: what a broadcaster reads before they buy, and the address every
// foreseeable refusal is moved onto so the expensive one is only ever reached
// when the answer is already yes (ADR 0003's amendment).
export { QUOTE_CONTENT_TYPE, NO_PAID_TERMINATION } from './quote/quote.js';
export type { SlotQuote, HeldSlot, QuoteRefusal } from './quote/quote.js';

// The hub's admission policy: price, period, cap and the hub's own address.
// Configuration a hub operator sets, never constants.
export {
  DEFAULT_HUB_ADDRESS,
  DEFAULT_SLOT_PRICE,
  DEFAULT_SLOT_PERIOD_SECONDS,
  DEFAULT_SLOT_CAP,
  SlotPolicyError,
  resolveSlotPolicy,
  describeSlotPolicy,
} from './slot/policy.js';
export type { SlotPolicy, SlotPolicyConfig } from './slot/policy.js';

// The roster — who holds a slot, and until when. A read surface only: the buy
// that writes one is #35.
export { createSlotRoster } from './slot/roster.js';
export type { Slot, SlotRoster } from './slot/roster.js';

// The handle a hub grants, derived from the payer the connector verified.
export {
  PAYER_HEADER,
  HANDLE_LABEL_HEX_LENGTH,
  HandleDerivationError,
  readPayerKey,
  deriveHandleLabel,
  grantedPrefix,
} from './slot/handle.js';

// The hub's two operator credentials. Both are mounted files named by path,
// both are required, and neither value is ever logged or reported back.
export {
  resolveOperatorCredentials,
  OperatorCredentialError,
} from './operator/credentials.js';
export type {
  OperatorCredentials,
  OperatorCredentialSource,
} from './operator/credentials.js';

export { VERSION } from './version.js';
