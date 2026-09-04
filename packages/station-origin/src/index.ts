/**
 * @toon-protocol/station-origin — the station origin.
 *
 * One broadcaster's node: it ingests their vibes and serves segments of them.
 * It is a plain HTTP app and contains no payment code — by the time a request
 * reaches it, the connector in front has already proven it paid.
 *
 * @module
 */

export { startOrigin } from './origin/origin.js';
export type {
  OriginConfig,
  OriginInstance,
  ResolvedOriginConfig,
} from './origin/origin.js';
export { VERSION } from './version.js';
