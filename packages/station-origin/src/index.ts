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

// Segments: what a viber pays for. One rung, cut into fixed-duration spans and
// addressed by rung and sequence number.
export {
  DEFAULT_RUNG,
  DEFAULT_SEGMENT_SECONDS,
  SEGMENT_BYTE_BUDGET,
  VBV_BUFFER_SECONDS,
  RUNG_NAME_PATTERN,
  RungError,
  rungPrefix,
  segmentPath,
  assertRung,
} from './segmenter/rung.js';
export type { Rung } from './segmenter/rung.js';
export { createSegmenter } from './segmenter/segmenter.js';
export type {
  Segment,
  SegmentLookup,
  SegmenterConfig,
  SegmenterInstance,
} from './segmenter/segmenter.js';
export {
  segmentRoutes,
  SEGMENTS_ROUTE_PREFIX,
  SEGMENT_CONTENT_TYPE,
} from './segmenter/routes.js';

export { VERSION } from './version.js';
