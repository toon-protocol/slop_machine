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
} from './slot-app/slot-app.js';
export type {
  SlotAppConfig,
  SlotAppInstance,
  ResolvedSlotAppConfig,
} from './slot-app/slot-app.js';

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
