/**
 * AMF0 — the encoding RTMP carries its commands in.
 *
 * RTMP's control plane (`connect`, `createStream`, `publish`, `onStatus`) is a
 * sequence of AMF0 values on a command message. The station origin has to read
 * enough of it to learn which app a broadcaster connected to and which stream
 * key they published with, and to write enough of it to tell them yes or no.
 *
 * Only the subset RTMP actually uses is implemented. Anything else in a
 * command payload is skipped rather than guessed at: an unknown marker ends
 * the decode, and the caller works with the values it did understand. That is
 * deliberate — a publisher that sends something exotic must not be able to
 * crash a broadcaster's node, and no decision here depends on a value past the
 * stream key.
 *
 * @module
 */

/** A value carried on an AMF0 command message. */
export type Amf0Value =
  number | string | boolean | null | undefined | Amf0Object | Amf0Value[];

/** An AMF0 object or ECMA array, decoded as a plain record. */
export interface Amf0Object {
  [key: string]: Amf0Value;
}

const MARKER_NUMBER = 0x00;
const MARKER_BOOLEAN = 0x01;
const MARKER_STRING = 0x02;
const MARKER_OBJECT = 0x03;
const MARKER_NULL = 0x05;
const MARKER_UNDEFINED = 0x06;
const MARKER_ECMA_ARRAY = 0x08;
const MARKER_OBJECT_END = 0x09;
const MARKER_STRICT_ARRAY = 0x0a;
const MARKER_LONG_STRING = 0x0c;

/**
 * Decode every AMF0 value in `buffer`.
 *
 * Stops at the first marker it does not understand and returns what it read up
 * to that point, rather than throwing: a command whose tail is unreadable is
 * still a command whose head named an app and a stream key.
 */
export function decodeAmf0(buffer: Buffer): Amf0Value[] {
  const values: Amf0Value[] = [];
  const cursor = { offset: 0 };
  while (cursor.offset < buffer.length) {
    const value = readValue(buffer, cursor);
    if (value === UNREADABLE) break;
    values.push(value);
  }
  return values;
}

/** Encode a sequence of AMF0 values into one buffer. */
export function encodeAmf0(values: Amf0Value[]): Buffer {
  return Buffer.concat(values.map(writeValue));
}

// ---------- Decoding ----------

/** Sentinel for "this buffer does not continue with a value we can read". */
const UNREADABLE = Symbol('amf0-unreadable');

interface Cursor {
  offset: number;
}

function readValue(
  buffer: Buffer,
  cursor: Cursor
): Amf0Value | typeof UNREADABLE {
  if (cursor.offset >= buffer.length) return UNREADABLE;
  const marker = buffer.readUInt8(cursor.offset);
  cursor.offset += 1;

  switch (marker) {
    case MARKER_NUMBER: {
      if (cursor.offset + 8 > buffer.length) return UNREADABLE;
      const value = buffer.readDoubleBE(cursor.offset);
      cursor.offset += 8;
      return value;
    }
    case MARKER_BOOLEAN: {
      if (cursor.offset + 1 > buffer.length) return UNREADABLE;
      const value = buffer.readUInt8(cursor.offset) !== 0;
      cursor.offset += 1;
      return value;
    }
    case MARKER_STRING:
      return readShortString(buffer, cursor);
    case MARKER_LONG_STRING: {
      if (cursor.offset + 4 > buffer.length) return UNREADABLE;
      const length = buffer.readUInt32BE(cursor.offset);
      cursor.offset += 4;
      if (cursor.offset + length > buffer.length) return UNREADABLE;
      const value = buffer.toString(
        'utf8',
        cursor.offset,
        cursor.offset + length
      );
      cursor.offset += length;
      return value;
    }
    case MARKER_OBJECT:
      return readObjectBody(buffer, cursor);
    case MARKER_ECMA_ARRAY: {
      // The count that precedes an ECMA array is advisory; the terminator is
      // what actually ends it, so the body is read exactly like an object.
      if (cursor.offset + 4 > buffer.length) return UNREADABLE;
      cursor.offset += 4;
      return readObjectBody(buffer, cursor);
    }
    case MARKER_STRICT_ARRAY: {
      if (cursor.offset + 4 > buffer.length) return UNREADABLE;
      const count = buffer.readUInt32BE(cursor.offset);
      cursor.offset += 4;
      const items: Amf0Value[] = [];
      for (let index = 0; index < count; index += 1) {
        const item = readValue(buffer, cursor);
        if (item === UNREADABLE) return UNREADABLE;
        items.push(item);
      }
      return items;
    }
    case MARKER_NULL:
      return null;
    case MARKER_UNDEFINED:
      return undefined;
    default:
      return UNREADABLE;
  }
}

function readShortString(
  buffer: Buffer,
  cursor: Cursor
): string | typeof UNREADABLE {
  if (cursor.offset + 2 > buffer.length) return UNREADABLE;
  const length = buffer.readUInt16BE(cursor.offset);
  cursor.offset += 2;
  if (cursor.offset + length > buffer.length) return UNREADABLE;
  const value = buffer.toString('utf8', cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return value;
}

function readObjectBody(
  buffer: Buffer,
  cursor: Cursor
): Amf0Object | typeof UNREADABLE {
  const object: Amf0Object = {};
  for (;;) {
    const key = readShortString(buffer, cursor);
    if (key === UNREADABLE) return UNREADABLE;
    if (key === '') {
      // The empty key is only ever the object terminator, which the 0x09
      // marker follows.
      if (cursor.offset >= buffer.length) return UNREADABLE;
      cursor.offset += 1;
      return object;
    }
    const value = readValue(buffer, cursor);
    if (value === UNREADABLE) return UNREADABLE;
    object[key] = value;
  }
}

// ---------- Encoding ----------

function writeValue(value: Amf0Value): Buffer {
  if (value === null) return Buffer.from([MARKER_NULL]);
  if (value === undefined) return Buffer.from([MARKER_UNDEFINED]);
  if (typeof value === 'number') {
    const out = Buffer.alloc(9);
    out.writeUInt8(MARKER_NUMBER, 0);
    out.writeDoubleBE(value, 1);
    return out;
  }
  if (typeof value === 'boolean') {
    return Buffer.from([MARKER_BOOLEAN, value ? 1 : 0]);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    const out = Buffer.alloc(3 + bytes.length);
    out.writeUInt8(MARKER_STRING, 0);
    out.writeUInt16BE(bytes.length, 1);
    bytes.copy(out, 3);
    return out;
  }
  if (Array.isArray(value)) {
    const header = Buffer.alloc(5);
    header.writeUInt8(MARKER_STRICT_ARRAY, 0);
    header.writeUInt32BE(value.length, 1);
    return Buffer.concat([header, ...value.map(writeValue)]);
  }
  const parts: Buffer[] = [Buffer.from([MARKER_OBJECT])];
  for (const [key, entry] of Object.entries(value)) {
    const keyBytes = Buffer.from(key, 'utf8');
    const keyHeader = Buffer.alloc(2 + keyBytes.length);
    keyHeader.writeUInt16BE(keyBytes.length, 0);
    keyBytes.copy(keyHeader, 2);
    parts.push(keyHeader, writeValue(entry));
  }
  parts.push(Buffer.from([0x00, 0x00, MARKER_OBJECT_END]));
  return Buffer.concat(parts);
}
