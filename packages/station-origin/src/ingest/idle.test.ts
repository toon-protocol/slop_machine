/**
 * The uplink that dies without saying so, and the station that notices anyway.
 *
 * `reconnect.test.ts` covers the drop a broadcaster comes back from. This file
 * covers the one they do not: the uplink that stops sending vibes, sends no
 * FIN and no RST, and is never heard from again. That connection sits
 * half-open. `close` never fires, `supersede()` is never reached because
 * nothing arrives to supersede anything, and without a rule of its own the
 * station would report `live: true` beside a sequence that never moves — for
 * ever. A viber cannot tell that from a station whose edge has merely stalled,
 * which is the exact distinction the *now* address exists to draw.
 *
 * **How the death is constructed, honestly.** Killing `ffmpeg` is not a silent
 * death: the kernel closes its socket on the way out and the origin sees a
 * FIN. So the publisher does not talk to the origin at all here. It publishes
 * — paced with `-re`, as a broadcaster's software sends it — at a plain TCP
 * relay this suite owns, which forwards the bytes on to the real ingest port
 * over a socket the suite holds. To kill the uplink, the relay simply stops
 * forwarding and **never touches the origin-side socket again**: it is not
 * ended, not destroyed, not half-closed. It stays ESTABLISHED with nothing
 * coming down it, which is precisely what the origin's kernel sees when a
 * broadcaster's router forgets the flow. The relay keeps draining whatever the
 * origin writes, so nothing is wedged by backpressure either — the connection
 * is, from the origin's side, in perfect health and completely silent.
 *
 * The suite proves that is a real gap rather than an artefact of the setup: a
 * second station, identical but for a long idle interval, is killed the same
 * way and goes on reporting itself live long past the point where the first
 * one has gone quiet. Only the rule closes it.
 *
 * It is all boundary. Real RTMP in over a real socket, plain HTTP out, and the
 * only thing this file knows about the inside of the origin is that a socket
 * it holds is one end of a TCP connection. Nothing reaches into the segmenter,
 * the ingest listener, the `ffmpeg` invocation or the on-disk layout.
 *
 * `ffmpeg` must be on PATH.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOrigin } from '../origin/origin.js';
import type { OriginConfig, OriginInstance } from '../origin/origin.js';
import { DEFAULT_INGEST_IDLE_SECONDS } from './idle.js';

/** The suite's ladder: two small rungs of different shapes, as configuration. */
const LADDER = 'audio:64k, small:360:500k:64k';
const RUNGS = ['audio', 'small'];

/** Fixed segment duration for the suite. */
const SEGMENT_SECONDS = 2;

/**
 * The idle interval the station under test runs with. Short, because the suite
 * has to wait it out — but a whole number of seconds and several segments
 * long, so it is the same rule an operator configures rather than a special
 * case.
 */
const IDLE_SECONDS = 5;

/**
 * The idle interval the control station runs with: long enough that it cannot
 * fire during this suite. It is the station that shows the gap is real.
 */
const PATIENT_IDLE_SECONDS = 600;

/** How many segments must exist before the uplink is killed. */
const HELD_SEGMENTS = 2;

/** How long each broadcast would run if nobody interrupted it. */
const BROADCAST_SECONDS = 120;

/** The station's *now*, written out here rather than imported. */
interface NowBody {
  live: boolean;
  segmentSeconds: number;
  rungs: { rung: string; sequence: number | null }[];
}

/** One segment as a viber received it: what came back, and the bytes. */
interface PulledSegment {
  status: number;
  contentType: string | null;
  body: Buffer;
}

const running: OriginInstance[] = [];
const tempDirs: string[] = [];
const publishers: ChildProcess[] = [];
const relays: SilenceableRelay[] = [];

/** The station whose broadcaster dies quietly. */
let station: OriginInstance;
/** The relay carrying that broadcaster's vibes, and holding the socket. */
let relay: SilenceableRelay;

/** The *now* while the doomed broadcast was still running. */
let beforeDeath: NowBody;
/** The *now* read immediately after the vibes stopped, before the rule fires. */
let justAfterDeath: NowBody;
/** The window held at the moment the vibes stopped, by rung and sequence. */
const held = new Map<string, Map<number, PulledSegment>>();
/** How long, in ms, the station took to go off the air after the last vibes. */
let noticedAfterMs = 0;
/** The first *now* that reported the station off the air. */
let offAir: NowBody;
/** Whether the origin was the side that finally dropped the dead connection. */
let originDroppedIt = false;
/** The *now* once the station had settled off the air. */
let settled: NowBody;
/** The first *now* that reported the returning broadcaster live. */
let back: NowBody;
/** A *now* read several segments into the second broadcast. */
let advanced: NowBody;
/** The lowest sequence any poll saw at each rung after the reconnect. */
const lowestAfterReturn = new Map<string, number>();

/** The control station, and what it still claimed long after its uplink died. */
let patientStation: OriginInstance;
let patientAfterMs = 0;
let patientStillLive: NowBody;

beforeAll(async () => {
  // ---- Live, with a window behind it ----

  station = await boot({ ingestIdleSeconds: IDLE_SECONDS });
  relay = await relayTo(station);
  const doomed = publish({ port: relay.port, streamKey: keyOf(station) });

  beforeDeath = await until(
    station,
    (now) =>
      now.live &&
      now.rungs.every((rung) => (rung.sequence ?? -1) >= HELD_SEGMENTS - 1),
    'the station never produced a window while the broadcaster published'
  );

  // Everything the station holds at the moment the vibes stop, pulled the way
  // a viber pulls it. These bytes are the evidence for the claims below.
  for (const rung of RUNGS) {
    const window = new Map<number, PulledSegment>();
    const edge = sequenceAt(beforeDeath, rung);
    for (let sequence = edge - (HELD_SEGMENTS - 1); sequence <= edge;) {
      window.set(sequence, await pull(station, rung, sequence));
      sequence += 1;
    }
    held.set(rung, window);
  }

  // ---- The uplink dies, and says nothing ----

  const diedAt = Date.now();
  relay.goSilent();
  doomed.child.kill('SIGKILL');
  await doomed.done;

  // Read once straight away: the origin has had no signal of any kind, so it
  // should still believe the broadcaster is there. That is the bug, caught in
  // the act, and the reason the rule has to exist at all.
  justAfterDeath = (await readNow(station)).body;

  offAir = await until(
    station,
    (now) => !now.live,
    'the station kept reporting ingest live after the uplink died silently',
    (IDLE_SECONDS + 30) * 1000
  );
  noticedAfterMs = Date.now() - diedAt;
  originDroppedIt = await relay.originSideClosed();
  settled = await still(station);

  // ---- The control: the same death, on a station with a long fuse ----

  patientStation = await boot({ ingestIdleSeconds: PATIENT_IDLE_SECONDS });
  const patientRelay = await relayTo(patientStation);
  const alsoDoomed = publish({
    port: patientRelay.port,
    streamKey: keyOf(patientStation),
  });
  await until(
    patientStation,
    (now) => now.live && now.rungs.every((rung) => (rung.sequence ?? -1) >= 0),
    'the control station never went live'
  );
  const patientDiedAt = Date.now();
  patientRelay.goSilent();
  alsoDoomed.child.kill('SIGKILL');
  await alsoDoomed.done;
  // Wait out the interval the station under test needed, and a healthy margin
  // on top, then ask. A station with no rule at all would answer exactly this.
  await rest(noticedAfterMs + 5_000);
  patientAfterMs = Date.now() - patientDiedAt;
  patientStillLive = (await readNow(patientStation)).body;

  // ---- The broadcaster comes back, long after being taken off the air ----

  const returning = publish({
    port: station.config.ingestPort,
    streamKey: keyOf(station),
  });
  back = await until(
    station,
    (now) => now.live,
    'the station never accepted the broadcaster back after the timeout'
  );

  for (const rung of RUNGS)
    lowestAfterReturn.set(rung, Number.MAX_SAFE_INTEGER);
  advanced = await until(
    station,
    (now) => {
      for (const rung of now.rungs) {
        if (rung.sequence === null) continue;
        const lowest =
          lowestAfterReturn.get(rung.rung) ?? Number.MAX_SAFE_INTEGER;
        lowestAfterReturn.set(rung.rung, Math.min(lowest, rung.sequence));
      }
      return now.rungs.every(
        (rung) => (rung.sequence ?? -1) > sequenceAt(settled, rung.rung) + 1
      );
    },
    'the returning broadcast never carried the edge past where the timeout left it'
  );

  returning.child.kill('SIGKILL');
  await returning.done;
}, 300_000);

afterAll(async () => {
  for (const child of publishers.splice(0)) child.kill('SIGKILL');
  for (const open of relays.splice(0)) await open.close();
  for (const origin of running.splice(0)) await origin.stop();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Booting and broadcasting, the way production does ----------

const keys = new WeakMap<OriginInstance, string>();

function keyOf(origin: OriginInstance): string {
  const key = keys.get(origin);
  if (key === undefined) throw new Error('that station was not booted here');
  return key;
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-idle-'));
  tempDirs.push(dir);
  return dir;
}

/** Boot a real origin on fresh ports against a temporary directory. */
async function boot(
  config: Partial<OriginConfig> = {}
): Promise<OriginInstance> {
  // A throwaway key, fresh per station. No stream key literal belongs in this
  // repo, not even a test's.
  const streamKey = `test-station-key-${randomUUID()}`;
  const origin = await startOrigin({
    segmentPort: 0,
    ingestPort: 0,
    host: '127.0.0.1',
    ingestHost: '127.0.0.1',
    dataDir: freshDir(),
    streamKey,
    rungs: LADDER,
    segmentSeconds: SEGMENT_SECONDS,
    ...config,
  });
  keys.set(origin, streamKey);
  running.push(origin);
  return origin;
}

/**
 * Publish a generated broadcast at a port, exactly as a broadcaster's software
 * would — a URL, a stream key as the stream name, and `-re` so the vibes
 * arrive at the speed they were shot rather than as fast as the box can encode
 * them.
 */
function publish(options: { port: number; streamKey: string }): {
  child: ChildProcess;
  done: Promise<{ code: number | null; output: string }>;
} {
  const { port, streamKey } = options;
  const seconds = BROADCAST_SECONDS;
  const url = `rtmp://127.0.0.1:${String(port)}/live/${streamKey}`;

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-re',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=640x480:rate=25:duration=${String(seconds)}`,
    '-re',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${String(seconds)}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-b:v',
    '1200k',
    '-g',
    '25',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-t',
    String(seconds),
    '-f',
    'flv',
    url,
  ];

  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  publishers.push(child);
  const done = new Promise<{ code: number | null; output: string }>(
    (resolvePublish) => {
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.on('close', (code) => resolvePublish({ code, output }));
    }
  );
  return { child, done };
}

// ---------- The uplink this suite can kill without a sound ----------

/**
 * A plain TCP relay in front of a station's ingest port, whose whole purpose is
 * that it can stop.
 *
 * Everything a publisher sends is forwarded verbatim, so what reaches the
 * origin is a real RTMP publish over a real socket, indistinguishable from one
 * `ffmpeg` opened itself. {@link goSilent} then stops the forwarding and
 * leaves the origin-side socket alone — open, connected, and quiet. Nothing
 * ends it, nothing destroys it, and the publisher's own socket dying is not
 * passed on, so the origin never receives a FIN or an RST. That is a half-open
 * uplink, built out of an actual TCP connection rather than described.
 */
interface SilenceableRelay {
  /** The port a publisher points at. */
  port: number;
  /** Stop forwarding, and abandon the origin-side socket in perfect silence. */
  goSilent(): void;
  /**
   * Whether the origin has since dropped its end — i.e. whether the rule acted
   * on the wire and not merely on the answer at `/now`. Waits briefly, because
   * a socket dropped on the far end takes a round trip to be seen here.
   */
  originSideClosed(): Promise<boolean>;
  close(): Promise<void>;
}

async function relayTo(origin: OriginInstance): Promise<SilenceableRelay> {
  const ingestPort = origin.config.ingestPort;
  let silent = false;
  let upstreamClosed = false;
  const opened: Socket[] = [];

  const server: Server = createServer((publisher) => {
    opened.push(publisher);
    const toOrigin = createConnection({ host: '127.0.0.1', port: ingestPort });
    opened.push(toOrigin);
    toOrigin.setNoDelay(true);
    publisher.setNoDelay(true);

    toOrigin.on('close', () => {
      upstreamClosed = true;
    });
    // Errors on either side are the connection's business, not the suite's:
    // after the silence the publisher's end is expected to break, and the
    // origin's end is expected to be dropped by the origin itself.
    toOrigin.on('error', () => undefined);
    publisher.on('error', () => undefined);

    publisher.on('data', (chunk: Buffer) => {
      if (silent || toOrigin.destroyed) return;
      toOrigin.write(chunk);
    });
    // Deliberately NOT forwarded: the publisher going away must not become a
    // FIN on the origin's socket, or this would be the ordinary drop that
    // `reconnect.test.ts` already covers rather than a silent death.
    publisher.on('close', () => undefined);

    toOrigin.on('data', (chunk: Buffer) => {
      // Read and discard once silent, so the origin's own writes are never
      // wedged by a full buffer. A dead uplink absorbs; it does not push back.
      if (silent || publisher.destroyed) return;
      publisher.write(chunk);
    });
  });

  await new Promise<void>((listening) => {
    server.listen(0, '127.0.0.1', () => listening());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the relay bound no port');
  }

  const open: SilenceableRelay = {
    port: address.port,
    goSilent() {
      silent = true;
    },
    async originSideClosed() {
      const deadline = Date.now() + 5_000;
      while (!upstreamClosed && Date.now() < deadline) await rest(100);
      return upstreamClosed;
    },
    close() {
      for (const socket of opened.splice(0)) socket.destroy();
      return new Promise<void>((closed) => server.close(() => closed()));
    },
  };
  relays.push(open);
  return open;
}

// ---------- Speaking to the station over plain HTTP ----------

function get(origin: OriginInstance, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(origin.config.segmentPort)}${path}`);
}

/** Read the station's *now*, as a viber does: one GET, one address. */
async function readNow(
  origin: OriginInstance
): Promise<{ res: Response; body: NowBody; text: string }> {
  const res = await get(origin, '/now');
  const text = await res.text();
  return { res, body: JSON.parse(text) as NowBody, text };
}

/** What that answer says the live edge is at one rung. */
function sequenceAt(now: NowBody, rung: string): number {
  const found = now.rungs.find((reported) => reported.rung === rung);
  if (found === undefined || found.sequence === null) {
    throw new Error(`now reported no sequence at rung "${rung}"`);
  }
  return found.sequence;
}

/** Pull one segment, the way a viber acts on what *now* told it. */
async function pull(
  origin: OriginInstance,
  rung: string,
  sequence: number
): Promise<PulledSegment> {
  const res = await get(origin, `/segments/${rung}/${String(sequence)}.ts`);
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    body: Buffer.from(await res.arrayBuffer()),
  };
}

/** Read *now* until it says something, or give up loudly. */
async function until(
  origin: OriginInstance,
  holds: (now: NowBody) => boolean,
  complaint: string,
  timeoutMs = 90_000
): Promise<NowBody> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await readNow(origin);
    if (holds(body)) return body;
    if (Date.now() > deadline) {
      throw new Error(`${complaint} (last answer: ${JSON.stringify(body)})`);
    }
    await rest(200);
  }
}

/** Read *now* until it stops moving — a station whose broadcaster has gone. */
async function still(origin: OriginInstance): Promise<NowBody> {
  let previous = '';
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { text } = await readNow(origin);
    if (text === previous) return JSON.parse(text) as NowBody;
    previous = text;
    if (Date.now() > deadline) {
      throw new Error(`the edge never settled (last answer: ${text})`);
    }
    await rest(500);
  }
}

function rest(ms: number): Promise<void> {
  return new Promise((tick) => setTimeout(tick, ms));
}

/** The window this suite held when the vibes stopped, at one rung. */
function heldAt(rung: string): Map<number, PulledSegment> {
  const window = held.get(rung);
  if (window === undefined) throw new Error(`nothing was held at "${rung}"`);
  return window;
}

// ---------- The tests ----------

describe('an uplink that dies without closing its socket', () => {
  it('is invisible to the origin at the moment it happens', () => {
    // The premise. No FIN, no RST, nothing: the station has had no signal of
    // any kind and still believes its broadcaster is there. Everything below
    // is about what closes that window, and this is what says the window was
    // genuinely open.
    expect(beforeDeath.live).toBe(true);
    expect(justAfterDeath.live).toBe(true);
  });

  it('would hold the air indefinitely if the rule did not fire', () => {
    // The control station: same death, same relay, same abandoned socket —
    // only the interval differs. It is still reporting itself live well past
    // the point where the station under test had gone quiet, which is exactly
    // what a station with no idle rule would answer for ever.
    expect(patientStillLive.live).toBe(true);
    expect(patientAfterMs).toBeGreaterThan(noticedAfterMs);
    expect(patientStation.config.ingestIdleSeconds).toBe(PATIENT_IDLE_SECONDS);
    expect(patientStation.isIngesting()).toBe(true);
  });

  it('takes the station off the air after the configured interval', () => {
    expect(offAir.live).toBe(false);
    expect(settled.live).toBe(false);
    expect(station.isIngesting()).toBe(false);
  });

  it('waits out the interval rather than firing early', () => {
    // Bounded on both sides: the station must not go quiet before the interval
    // an operator configured, and must not take much longer than it either.
    expect(noticedAfterMs).toBeGreaterThan((IDLE_SECONDS - 2) * 1000);
    expect(noticedAfterMs).toBeLessThan((IDLE_SECONDS + 15) * 1000);
  });

  it('drops the dead connection itself rather than waiting for TCP to', () => {
    // The suite never touched that socket after going silent. It is closed
    // now, so the origin is what closed it — the rule acted on the wire, not
    // just on the answer at /now.
    expect(originDroppedIt).toBe(true);
  });

  it('says so at the same address, not by going missing', () => {
    expect(settled.segmentSeconds).toBe(SEGMENT_SECONDS);
    expect(settled.rungs.map((rung) => rung.rung)).toEqual(RUNGS);
  });

  it('is still distinguishable from a station that never went live', () => {
    // Both say `live: false`. What separates them is the window: this one is
    // holding vibes a viber can still buy, and it names them with a number
    // rather than `null`.
    for (const rung of settled.rungs) {
      expect(typeof rung.sequence).toBe('number');
      expect(rung.sequence).toBeGreaterThanOrEqual(HELD_SEGMENTS - 1);
    }
  });
});

describe('the window a dead broadcaster left behind', () => {
  it('is still servable at the sequences a viber already knew', async () => {
    for (const rung of RUNGS) {
      const window = heldAt(rung);
      expect(window.size).toBe(HELD_SEGMENTS);
      for (const [sequence, before] of window) {
        expect({ rung, sequence, status: before.status }).toEqual({
          rung,
          sequence,
          status: 200,
        });
        const after = await pull(station, rung, sequence);
        expect({ rung, sequence, status: after.status }).toEqual({
          rung,
          sequence,
          status: 200,
        });
        expect(after.contentType).toBe('video/mp2t');
        // The same bytes at the same address. Going off the air is a fact
        // about ingest; it re-lets nothing a viber already paid for.
        expect({
          rung,
          sequence,
          same: after.body.equals(before.body),
        }).toEqual({ rung, sequence, same: true });
      }
    }
  });

  it('still names its edge, and that edge is still buyable', async () => {
    for (const rung of RUNGS) {
      const edge = sequenceAt(settled, rung);
      const segment = await pull(station, rung, edge);
      expect({ rung, status: segment.status }).toEqual({ rung, status: 200 });
      expect(segment.body.length).toBeGreaterThan(0);
    }
  });
});

describe('a broadcaster who comes back after being taken off the air', () => {
  it('is accepted, and the station reports ingest live again', () => {
    expect(back.live).toBe(true);
    expect(advanced.live).toBe(true);
    expect(advanced.segmentSeconds).toBe(SEGMENT_SECONDS);
    expect(advanced.rungs.map((rung) => rung.rung)).toEqual(RUNGS);
  });

  it('continues the sequence rather than restarting it at zero', () => {
    for (const rung of RUNGS) {
      const edgeAtTimeout = sequenceAt(settled, rung);
      expect(sequenceAt(advanced, rung)).toBeGreaterThan(edgeAtTimeout);
      // And it never went back down: every answer read after the return named
      // a sequence at or above the one the timeout left behind.
      expect(lowestAfterReturn.get(rung)).toBeGreaterThanOrEqual(edgeAtTimeout);
    }
  });

  it('does not re-let an address a viber already paid for', async () => {
    // The strong form of the same claim, in bytes, after the station has been
    // live again for several segments.
    for (const rung of RUNGS) {
      for (const [sequence, before] of heldAt(rung)) {
        const after = await pull(station, rung, sequence);
        expect({
          rung,
          sequence,
          status: after.status,
          same: after.body.equals(before.body),
        }).toEqual({ rung, sequence, status: 200, same: true });
      }
    }
  });

  it('serves one continuous window across the silence', async () => {
    for (const rung of RUNGS) {
      const across = [
        Math.min(...heldAt(rung).keys()),
        sequenceAt(settled, rung),
        sequenceAt(settled, rung) + 1,
        sequenceAt(advanced, rung),
      ];
      for (const sequence of across) {
        const segment = await pull(station, rung, sequence);
        expect({ rung, sequence, status: segment.status }).toEqual({
          rung,
          sequence,
          status: 200,
        });
        expect(segment.body.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('the idle interval as configuration', () => {
  it('is reported back on the station it is running with', () => {
    expect(station.config.ingestIdleSeconds).toBe(IDLE_SECONDS);
  });

  it('defaults to the documented interval when nothing sets it', async () => {
    const plain = await boot();
    expect(plain.config.ingestIdleSeconds).toBe(DEFAULT_INGEST_IDLE_SECONDS);
  });

  it('refuses to start on a value that would switch the rule off', async () => {
    for (const idle of [0, -1]) {
      await expect(boot({ ingestIdleSeconds: idle })).rejects.toThrow(
        /IngestIdle|whole number of seconds/
      );
    }
  });

  it('refuses to start on a value that is not whole seconds', async () => {
    await expect(boot({ ingestIdleSeconds: 2.5 })).rejects.toThrow(
      /whole number of seconds/
    );
  });

  it('names the refusal so an operator can act on it', async () => {
    // A named error, not a stack trace: the CLI's allowlist turns exactly this
    // into a one-line refusal and a non-zero exit.
    await expect(boot({ ingestIdleSeconds: 0 })).rejects.toMatchObject({
      name: 'IngestIdleError',
    });
  });

  it('refuses before it binds anything, so nothing is left listening', async () => {
    // The refusal has to be a station that never came up, not one holding two
    // ports open. If it were, the next boot below would be racing it.
    await expect(boot({ ingestIdleSeconds: 0 })).rejects.toThrow();
    const after = await boot({ ingestIdleSeconds: 1 });
    expect(after.isRunning()).toBe(true);
    expect(after.config.ingestIdleSeconds).toBe(1);
  });
});
