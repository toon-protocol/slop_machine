/**
 * One RTMP connection, from handshake to publish.
 *
 * This module speaks the wire protocol and nothing else: it does the RTMP
 * handshake, reassembles chunks into messages, answers the four commands a
 * publisher sends (`connect`, `releaseStream`/`FCPublish`, `createStream`,
 * `publish`), and turns the audio, video and metadata messages that follow
 * into FLV tags. It holds no policy — whether a publish is allowed is a
 * question it asks its handler and never answers itself.
 *
 * The order matters and is the point of the ticket: the handler is asked on
 * the `publish` command, which arrives before the publisher sends a single
 * media byte. A refusal therefore costs nothing to transcode and reaches the
 * broadcaster's software while it is still waiting to be told it may start,
 * which is what makes a bad stream key show up in OBS immediately rather than
 * after a broadcast to nobody.
 *
 * Media is emitted as FLV — an FLV header followed by one tag per message —
 * because that is the byte format `ffmpeg` reads from a pipe, and the
 * segmenter is what will consume it.
 *
 * @module
 */

import type { Duplex } from 'node:stream';
import {
  decodeAmf0,
  encodeAmf0,
  type Amf0Object,
  type Amf0Value,
} from './amf0.js';

// ---------- The seam this module offers ----------

/** What a publisher asked to do, as read off the wire. */
export interface RtmpPublishRequest {
  /** The app the publisher connected to — `live` in `rtmp://host/live/<key>`. */
  app: string;
  /** The stream name the publisher published under. This carries the stream key. */
  streamName: string;
  /** The publisher's address, for logs. */
  remoteAddress: string | undefined;
}

/** Somewhere for a publish's FLV bytes to go. */
export interface RtmpMediaSink {
  /** One FLV byte range: the header first, then one tag per media message. */
  write(flv: Buffer): void;
  /** The publish ended — cleanly or otherwise. */
  end(): void;
}

/** The handler's answer to a publish request. */
export type RtmpPublishDecision =
  | {
      accepted: true;
      /** Where to put the vibes. Omit to accept the publish and discard them. */
      media?: RtmpMediaSink;
    }
  | {
      accepted: false;
      /** An RTMP status code, e.g. `NetStream.Publish.Denied`. */
      code: string;
      /** Human-readable reason, shown by the publishing client. */
      description: string;
    };

/** What a session asks of its owner. */
export interface RtmpSessionHandler {
  /**
   * Decide a publish. Called on the `publish` command and before any media is
   * read, so a refusal transcodes nothing.
   */
  onPublish(request: RtmpPublishRequest): RtmpPublishDecision;
  /** The publish that `onPublish` accepted has ended. */
  onPublishEnd(request: RtmpPublishRequest, bytes: number): void;
  /** Something went wrong on the connection. Informational; the socket is already closing. */
  onError?(error: Error): void;
}

// ---------- Protocol constants ----------

const RTMP_VERSION = 3;
const HANDSHAKE_SIZE = 1536;
const DEFAULT_CHUNK_SIZE = 128;
/** What we ask the publisher to let us send in one chunk. */
const OUT_CHUNK_SIZE = 4096;
/** Window acknowledgement size we advertise, in bytes. */
const WINDOW_SIZE = 5_000_000;
/** Peer bandwidth limit type 2 = "dynamic". */
const PEER_BANDWIDTH_DYNAMIC = 2;

const TYPE_SET_CHUNK_SIZE = 1;
const TYPE_ABORT = 2;
const TYPE_ACKNOWLEDGEMENT = 3;
const TYPE_USER_CONTROL = 4;
const TYPE_WINDOW_ACK_SIZE = 5;
const TYPE_SET_PEER_BANDWIDTH = 6;
const TYPE_AUDIO = 8;
const TYPE_VIDEO = 9;
const TYPE_DATA_AMF3 = 15;
const TYPE_COMMAND_AMF3 = 17;
const TYPE_DATA_AMF0 = 18;
const TYPE_COMMAND_AMF0 = 20;

/** Chunk stream ids we send on. Anything but 2 is an ordinary message stream. */
const CSID_PROTOCOL_CONTROL = 2;
const CSID_COMMAND = 3;
const CSID_STREAM = 5;

/** The one message stream id we hand out for a publish. */
const PUBLISH_STREAM_ID = 1;

/**
 * A refused publish is told this. `NetStream.Publish.Denied` is the code Flash
 * Media Server used for exactly this case, so publishing clients already know
 * how to surface it.
 */
export const PUBLISH_DENIED_CODE = 'NetStream.Publish.Denied';

// ---------- Chunk reassembly state ----------

interface ChunkStreamState {
  timestamp: number;
  timestampDelta: number;
  length: number;
  typeId: number;
  streamId: number;
  extendedTimestamp: boolean;
  received: number;
  parts: Buffer[];
}

interface RtmpMessage {
  typeId: number;
  streamId: number;
  timestamp: number;
  payload: Buffer;
}

/**
 * Attach the RTMP protocol to an accepted connection.
 *
 * The socket may be a plain TCP socket or a TLS one — RTMPS is RTMP over TLS
 * and nothing in this module can tell the difference, which is why the TLS
 * decision lives one level up with the listener.
 */
export function handleRtmpConnection(
  socket: Duplex & { remoteAddress?: string | undefined },
  handler: RtmpSessionHandler
): void {
  const remoteAddress = socket.remoteAddress;

  let pending: Buffer = Buffer.alloc(0);
  let phase: 'c0c1' | 'c2' | 'chunks' = 'c0c1';
  let inChunkSize = DEFAULT_CHUNK_SIZE;
  const chunkStreams = new Map<number, ChunkStreamState>();

  let app = '';
  let request: RtmpPublishRequest | undefined;
  let sink: RtmpMediaSink | undefined;
  let publishing = false;
  let mediaBytes = 0;
  let bytesRead = 0;
  let lastAcknowledged = 0;
  let closed = false;

  socket.on('data', (data: Buffer) => {
    bytesRead += data.length;
    pending = pending.length === 0 ? data : Buffer.concat([pending, data]);
    try {
      consume();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });

  socket.on('error', (error: Error) => {
    handler.onError?.(error);
    finish();
  });
  socket.on('close', finish);

  function finish(): void {
    if (closed) return;
    closed = true;
    if (publishing && request) {
      publishing = false;
      sink?.end();
      handler.onPublishEnd(request, mediaBytes);
    }
  }

  function fail(error: Error): void {
    handler.onError?.(error);
    socket.destroy();
    finish();
  }

  // ---------- Reading ----------

  function consume(): void {
    for (;;) {
      if (phase === 'c0c1') {
        if (pending.length < 1 + HANDSHAKE_SIZE) return;
        const version = pending.readUInt8(0);
        if (version !== RTMP_VERSION) {
          fail(new Error(`unsupported RTMP version ${String(version)}`));
          return;
        }
        const c1 = pending.subarray(1, 1 + HANDSHAKE_SIZE);
        // The simple handshake. S1's version field stays zero, which is what
        // tells ffmpeg and librtmp not to expect a digest; S2 echoes C1, which
        // is what librtmp verifies.
        const s1 = Buffer.alloc(HANDSHAKE_SIZE);
        s1.writeUInt32BE(0, 0);
        s1.writeUInt32BE(0, 4);
        for (let index = 8; index < HANDSHAKE_SIZE; index += 1) {
          s1.writeUInt8(Math.floor(Math.random() * 256), index);
        }
        socket.write(
          Buffer.concat([Buffer.from([RTMP_VERSION]), s1, Buffer.from(c1)])
        );
        pending = pending.subarray(1 + HANDSHAKE_SIZE);
        phase = 'c2';
        continue;
      }

      if (phase === 'c2') {
        if (pending.length < HANDSHAKE_SIZE) return;
        pending = pending.subarray(HANDSHAKE_SIZE);
        phase = 'chunks';
        sendWindowAckSize();
        sendSetPeerBandwidth();
        sendSetChunkSize();
        continue;
      }

      const message = readChunk();
      if (message === 'incomplete') return;
      if (message !== undefined) handleMessage(message);
      acknowledgeIfDue();
    }
  }

  /**
   * Read one chunk off `pending`. Returns the message it completed, `undefined`
   * if the chunk was a fragment of a longer message, or `'incomplete'` if the
   * chunk itself has not fully arrived.
   */
  function readChunk(): RtmpMessage | undefined | 'incomplete' {
    if (pending.length < 1) return 'incomplete';
    const first = pending.readUInt8(0);
    const format = first >> 6;

    let csid = first & 0x3f;
    let offset = 1;
    if (csid === 0) {
      if (pending.length < 2) return 'incomplete';
      csid = pending.readUInt8(1) + 64;
      offset = 2;
    } else if (csid === 1) {
      if (pending.length < 3) return 'incomplete';
      csid = pending.readUInt16LE(1) + 64;
      offset = 3;
    }

    const headerLength =
      format === 0 ? 11 : format === 1 ? 7 : format === 2 ? 3 : 0;
    if (pending.length < offset + headerLength) return 'incomplete';

    let state = chunkStreams.get(csid);
    if (state === undefined) {
      if (format !== 0) {
        // A continuation for a chunk stream we have never seen. Nothing can be
        // reconstructed from it, so the connection is not one we can follow.
        throw new Error(
          `chunk stream ${String(csid)} continued before it began`
        );
      }
      state = {
        timestamp: 0,
        timestampDelta: 0,
        length: 0,
        typeId: 0,
        streamId: 0,
        extendedTimestamp: false,
        received: 0,
        parts: [],
      };
      chunkStreams.set(csid, state);
    }

    let rawTimestamp = format === 3 ? -1 : pending.readUIntBE(offset, 3);
    if (format === 0) {
      state.length = pending.readUIntBE(offset + 3, 3);
      state.typeId = pending.readUInt8(offset + 6);
      state.streamId = pending.readUInt32LE(offset + 7);
    } else if (format === 1) {
      state.length = pending.readUIntBE(offset + 3, 3);
      state.typeId = pending.readUInt8(offset + 6);
    }
    offset += headerLength;

    // An extended timestamp follows whenever the 24-bit field is saturated,
    // and also on every continuation chunk of a message that used one.
    const usesExtended =
      rawTimestamp === 0xffffff || (format === 3 && state.extendedTimestamp);
    if (usesExtended) {
      if (pending.length < offset + 4) return 'incomplete';
      rawTimestamp = pending.readUInt32BE(offset);
      offset += 4;
    }
    if (state.received === 0) state.extendedTimestamp = usesExtended;

    if (format === 0) {
      state.timestamp = rawTimestamp;
      state.timestampDelta = 0;
    } else if (format === 1 || format === 2) {
      state.timestampDelta = rawTimestamp;
    }

    const remaining = state.length - state.received;
    const take = Math.min(remaining, inChunkSize);
    if (pending.length < offset + take) return 'incomplete';

    if (state.received === 0 && format !== 0) {
      state.timestamp += state.timestampDelta;
    }
    state.parts.push(Buffer.from(pending.subarray(offset, offset + take)));
    state.received += take;
    pending = pending.subarray(offset + take);

    if (state.received < state.length) return undefined;

    const payload = Buffer.concat(state.parts);
    state.parts = [];
    state.received = 0;
    return {
      typeId: state.typeId,
      streamId: state.streamId,
      timestamp: state.timestamp,
      payload,
    };
  }

  function handleMessage(message: RtmpMessage): void {
    switch (message.typeId) {
      case TYPE_SET_CHUNK_SIZE: {
        const size = message.payload.readUInt32BE(0) & 0x7fffffff;
        if (size > 0) inChunkSize = size;
        return;
      }
      case TYPE_ABORT:
      case TYPE_ACKNOWLEDGEMENT:
      case TYPE_USER_CONTROL:
      case TYPE_WINDOW_ACK_SIZE:
      case TYPE_SET_PEER_BANDWIDTH:
        return;
      case TYPE_COMMAND_AMF0:
        handleCommand(message.payload);
        return;
      case TYPE_COMMAND_AMF3:
        // AMF3 command messages are an AMF0 payload behind one marker byte.
        handleCommand(message.payload.subarray(1));
        return;
      case TYPE_AUDIO:
      case TYPE_VIDEO:
      case TYPE_DATA_AMF0:
        handleMedia(message);
        return;
      case TYPE_DATA_AMF3:
        handleMedia({
          ...message,
          typeId: TYPE_DATA_AMF0,
          payload: message.payload.subarray(1),
        });
        return;
      default:
        return;
    }
  }

  function handleCommand(payload: Buffer): void {
    const values = decodeAmf0(payload);
    const name = values[0];
    if (typeof name !== 'string') return;
    const transactionId = typeof values[1] === 'number' ? values[1] : 0;

    switch (name) {
      case 'connect': {
        const commandObject = values[2];
        if (
          isAmf0Object(commandObject) &&
          typeof commandObject['app'] === 'string'
        ) {
          app = commandObject['app'];
        }
        sendCommand(CSID_COMMAND, 0, [
          '_result',
          transactionId,
          { fmsVer: 'FMS/3,0,1,123', capabilities: 31 },
          {
            level: 'status',
            code: 'NetConnection.Connect.Success',
            description: 'Connection succeeded.',
            objectEncoding: 0,
          },
        ]);
        return;
      }
      case 'releaseStream':
      case 'FCPublish':
      case 'FCUnpublish':
        // Acknowledged so a client that waits does not stall. Neither command
        // decides anything here: the stream key is checked on `publish`.
        if (transactionId > 0) {
          sendCommand(CSID_COMMAND, 0, ['_result', transactionId, null, null]);
        }
        return;
      case 'createStream':
        sendCommand(CSID_COMMAND, 0, [
          '_result',
          transactionId,
          null,
          PUBLISH_STREAM_ID,
        ]);
        return;
      case 'publish': {
        const streamName = typeof values[3] === 'string' ? values[3] : '';
        handlePublish(streamName);
        return;
      }
      case 'deleteStream':
      case 'closeStream':
        finish();
        return;
      default:
        return;
    }
  }

  /**
   * The gate. Nothing has been transcoded and no media message has been read
   * when this runs — the publisher is still waiting to be told it may start.
   */
  function handlePublish(streamName: string): void {
    const publishRequest: RtmpPublishRequest = {
      app,
      streamName,
      remoteAddress,
    };
    const decision = handler.onPublish(publishRequest);

    if (!decision.accepted) {
      sendCommand(CSID_STREAM, PUBLISH_STREAM_ID, [
        'onStatus',
        0,
        null,
        {
          level: 'error',
          code: decision.code,
          description: decision.description,
        },
      ]);
      // Told, then hung up: a refusal the publisher can read but cannot follow
      // with media.
      socket.end();
      return;
    }

    request = publishRequest;
    sink = decision.media;
    publishing = true;
    mediaBytes = 0;

    sendStreamBegin(PUBLISH_STREAM_ID);
    sendCommand(CSID_STREAM, PUBLISH_STREAM_ID, [
      'onStatus',
      0,
      null,
      {
        level: 'status',
        code: 'NetStream.Publish.Start',
        description: `${streamName} is now published.`,
      },
    ]);
    sink?.write(flvHeader());
  }

  function handleMedia(message: RtmpMessage): void {
    if (!publishing) return;
    mediaBytes += message.payload.length;
    if (sink === undefined) return;
    const payload =
      message.typeId === TYPE_DATA_AMF0
        ? stripSetDataFrame(message.payload)
        : message.payload;
    if (payload.length === 0) return;
    sink.write(flvTag(message.typeId, message.timestamp, payload));
  }

  // ---------- Writing ----------

  function sendCommand(
    csid: number,
    streamId: number,
    values: Amf0Value[]
  ): void {
    sendMessage(csid, TYPE_COMMAND_AMF0, streamId, encodeAmf0(values));
  }

  function sendWindowAckSize(): void {
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(WINDOW_SIZE, 0);
    sendMessage(CSID_PROTOCOL_CONTROL, TYPE_WINDOW_ACK_SIZE, 0, payload);
  }

  function sendSetPeerBandwidth(): void {
    const payload = Buffer.alloc(5);
    payload.writeUInt32BE(WINDOW_SIZE, 0);
    payload.writeUInt8(PEER_BANDWIDTH_DYNAMIC, 4);
    sendMessage(CSID_PROTOCOL_CONTROL, TYPE_SET_PEER_BANDWIDTH, 0, payload);
  }

  function sendSetChunkSize(): void {
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(OUT_CHUNK_SIZE, 0);
    sendMessage(CSID_PROTOCOL_CONTROL, TYPE_SET_CHUNK_SIZE, 0, payload);
  }

  function sendStreamBegin(streamId: number): void {
    const payload = Buffer.alloc(6);
    payload.writeUInt16BE(0, 0);
    payload.writeUInt32BE(streamId, 2);
    sendMessage(CSID_PROTOCOL_CONTROL, TYPE_USER_CONTROL, 0, payload);
  }

  /** Tell the publisher how much we have read, once per advertised window. */
  function acknowledgeIfDue(): void {
    if (bytesRead - lastAcknowledged < WINDOW_SIZE) return;
    lastAcknowledged = bytesRead;
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(bytesRead % 0xffffffff, 0);
    sendMessage(CSID_PROTOCOL_CONTROL, TYPE_ACKNOWLEDGEMENT, 0, payload);
  }

  function sendMessage(
    csid: number,
    typeId: number,
    streamId: number,
    payload: Buffer
  ): void {
    if (socket.writableEnded || socket.destroyed) return;
    const header = Buffer.alloc(12);
    header.writeUInt8(csid & 0x3f, 0);
    header.writeUIntBE(0, 1, 3);
    header.writeUIntBE(payload.length, 4, 3);
    header.writeUInt8(typeId, 7);
    header.writeUInt32LE(streamId, 8);

    const parts: Buffer[] = [header];
    for (let offset = 0; offset < payload.length; offset += OUT_CHUNK_SIZE) {
      if (offset > 0) parts.push(Buffer.from([0xc0 | (csid & 0x3f)]));
      parts.push(payload.subarray(offset, offset + OUT_CHUNK_SIZE));
    }
    socket.write(Buffer.concat(parts));
  }
}

// ---------- FLV ----------

/** The nine-byte FLV header plus the leading zero back-pointer. */
function flvHeader(): Buffer {
  const header = Buffer.alloc(13);
  header.write('FLV', 0, 'ascii');
  header.writeUInt8(1, 3);
  // Audio and video both present. A publisher sending only one is still
  // readable; the flag is advisory.
  header.writeUInt8(0x05, 4);
  header.writeUInt32BE(9, 5);
  header.writeUInt32BE(0, 9);
  return header;
}

/** One FLV tag, with the back-pointer that follows every tag. */
function flvTag(typeId: number, timestamp: number, data: Buffer): Buffer {
  const tag = Buffer.alloc(11 + data.length + 4);
  tag.writeUInt8(typeId, 0);
  tag.writeUIntBE(data.length, 1, 3);
  tag.writeUIntBE(timestamp & 0xffffff, 4, 3);
  tag.writeUInt8((timestamp >>> 24) & 0xff, 7);
  tag.writeUIntBE(0, 8, 3);
  data.copy(tag, 11);
  tag.writeUInt32BE(11 + data.length, 11 + data.length);
  return tag;
}

/**
 * Metadata arrives over RTMP wrapped in a `@setDataFrame` call. FLV carries the
 * inner `onMetaData` directly, so the wrapper comes off.
 */
function stripSetDataFrame(payload: Buffer): Buffer {
  if (payload.length < 3 || payload.readUInt8(0) !== 0x02) return payload;
  const length = payload.readUInt16BE(1);
  if (payload.length < 3 + length) return payload;
  const name = payload.toString('utf8', 3, 3 + length);
  return name === '@setDataFrame' ? payload.subarray(3 + length) : payload;
}

function isAmf0Object(value: Amf0Value): value is Amf0Object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
