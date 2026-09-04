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
  BUY_ROUTE_PREFIX,
} from './slot-app/slot-app.js';
export type {
  SlotAppConfig,
  SlotAppInstance,
  ResolvedSlotAppConfig,
} from './slot-app/slot-app.js';

// The quote: what a broadcaster reads before they buy, and the address every
// foreseeable refusal is moved onto so the expensive one is only ever reached
// when the answer is already yes (ADR 0003's amendment).
export { QUOTE_CONTENT_TYPE } from './quote/quote.js';
export type { SlotQuote, HeldSlot, QuoteRefusal } from './quote/quote.js';

// The buy: the peering, established synchronously, before the answer. The
// fulfill means you are peered.
export {
  AMOUNT_HEADER,
  CHAIN_HEADER,
  ROUTE_UNDER_CHARGES,
  NO_STATION_URL,
  STATION_UNREADABLE,
  STATION_NOT_AT_PREFIX,
  ROUTE_OWNED_BY_CONFIG,
  ROUTES_NOT_WRITTEN,
  PEERING_NOT_ESTABLISHED,
  SLOT_NOT_RECORDED,
} from './buy/buy.js';
export type {
  BuyRequest,
  BoughtSlot,
  BoughtPeering,
  BoughtChannel,
  BoughtRoute,
} from './buy/buy.js';

// The refusals both paid addresses share. A refusal at a paid address is paid
// for (ADR 0003's amendment), so this set is deliberately small.
export {
  NO_PAID_TERMINATION,
  NO_PAID_TERMINATION_MESSAGE,
} from './slot/refusal.js';
export type { SlotAppRefusal } from './slot/refusal.js';

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

// The roster — who holds a slot, and until when. Durable: `record` returns
// only once the slot is on disk, which is what makes a purchase whose answer
// arrived too late findable by the retry rather than paid for twice.
export {
  createSlotRoster,
  openSlotRoster,
  SlotRosterError,
} from './slot/roster.js';
export type { Slot, SlotRoster } from './slot/roster.js';

// The peering the hub's operator key creates in response to a purchase — and
// the hub's own terms for it, which a broadcaster never chooses.
export { establishPeering, PeeringError } from './peering/peering.js';
export type {
  EstablishedPeering,
  PeeringChannel,
  PeeringFailure,
} from './peering/peering.js';
export {
  DEFAULT_PEERING_FEE,
  DEFAULT_PEERING_MAX_PACKET_AMOUNT,
  PeeringPolicyError,
  resolvePeeringPolicy,
  describePeeringPolicy,
} from './peering/policy.js';
export type { PeeringPolicy, PeeringPolicyConfig } from './peering/policy.js';

// The station's own self-description — the document every route price is
// derived from, so that nothing is declared by the buyer and nothing drifts.
export { readStationDescription } from './peering/station-description.js';
export type {
  StationDescription,
  PublishedRoute,
} from './peering/station-description.js';

// The forwarded routes: being peered is not yet being reachable, and a hub
// carries only what its routing table names.
export {
  deriveForwardedRoutes,
  writeForwardedRoutes,
  retireForwardedRoutes,
  ForwardedRouteError,
} from './peering/routes.js';
export type {
  ForwardedRoute,
  ForwardedRouteFailure,
  ForwardedRouteTerms,
  ForwardedRouteRequest,
  ForwardedRouteDependencies,
  ForwardedRouteRetirement,
  CarriedRoute,
  DerivedRoutes,
} from './peering/routes.js';

// Signing an operator write: RFC 9421, held to the verifier it targets.
export {
  createWriteSigner,
  SIGNATURE_TTL_SECONDS,
} from './operator/write-signature.js';
export type {
  WriteSigner,
  WriteSignature,
} from './operator/write-signature.js';

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
