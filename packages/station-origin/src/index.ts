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

// Ingest: the door a broadcaster's vibes come in through. Authenticated on the
// stream key at publish time, and never paid.
export {
  startIngest,
  DEFAULT_INGEST_PORT,
  DEFAULT_INGEST_HOST,
  IngestTlsError,
} from './ingest/ingest.js';
export type {
  IngestConfig,
  IngestInstance,
  IngestSession,
  IngestTlsConfig,
} from './ingest/ingest.js';
export { resolveStreamKey, StreamKeyError } from './ingest/stream-key.js';
export type { StreamKeySource } from './ingest/stream-key.js';

export { VERSION } from './version.js';
