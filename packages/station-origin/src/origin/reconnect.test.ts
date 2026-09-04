/**
 * A dropped ingest, and the station that lives through it.
 *
 * A broadcaster's uplink is not a wire in a rack — it is a hotel Wi-Fi, a
 * phone tethered in a car, a home connection that renegotiates. So the drop is
 * the ordinary case, not the exception, and what the origin does with it is
 * the whole of this file:
 *
 *   - the window it already holds stays servable, so a blip does not drop
 *     every viber at once;
 *   - the station's *now* says "no ingest", so a viber can tell a stalled edge
 *     apart from a station that ended, and a station mid-blip apart from one
 *     that never went live at all;
 *   - a reconnect with the right stream key is accepted, and a reconnect with
 *     the wrong one is still refused — a drop opens no door;
 *   - and the sequence **continues**. A viber who was mid-window is not thrown
 *     back to the beginning, and no address they already paid for quietly
 *     starts serving different vibes.
 *
 * That last one is the reason this file exists rather than a line in the
 * *now*'s suite. "Resumes" is easy to fake: an encoder that restarts at zero
 * looks live again within a segment. What it has actually done is re-let every
 * address in the window, so the span a viber bought as sequence 3 is now a
 * different span at the same price. The assertions below therefore hold onto
 * the bytes of a segment produced *before* the drop and demand them back,
 * unchanged, after the station has been live again for several segments.
 *
 * It is all boundary: real RTMP in — paced with `-re`, as a broadcaster's
 * software sends it — and plain HTTP out. Nothing here reaches inside the
 * segmenter, the ingest listener, the `ffmpeg` invocation or the on-disk
 * layout, so how the origin survives a drop stays rewritable without touching
 * this file.
 *
 * `ffmpeg` must be on PATH.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOrigin } from './origin.js';
import type { OriginConfig, OriginInstance } from './origin.js';

/** The suite's ladder: two small rungs of different shapes, as configuration. */
const LADDER = 'audio:64k, small:360:500k:64k';
const AUDIO_RUNG = 'audio';
const VIDEO_RUNG = 'small';
const RUNGS = [AUDIO_RUNG, VIDEO_RUNG];

/** Fixed segment duration for the suite. */
const SEGMENT_SECONDS = 2;

/**
 * How long each of the two broadcasts would run if nobody interrupted it. The
 * first one is cut short on purpose; the second is left to finish.
 */
const BROADCAST_SECONDS = 120;

/**
 * How many segments the first broadcast must produce before it is cut off.
 *
 * More than one, because a single segment cannot show a window, and it is a
 * window — not a segment — that has to survive the drop.
 */
const HELD_SEGMENTS = 3;

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

/** The one station the whole drop-and-resume story happens to. */
let station: OriginInstance;
/** A second station that never had a broadcaster, for the telling-apart. */
let neverLive: NowBody;

/** The *now* read while the first broadcast was running. */
let beforeDrop: NowBody;
/** The *now* once the killed publisher's edge had stopped moving. */
let dropped: NowBody;
/** The window held at the moment of the drop, by rung and sequence. */
const held = new Map<string, Map<number, PulledSegment>>();
/** What a wrong stream key got while the station was between broadcasters. */
let refused: { code: number | null; output: string };
/** The *now* read after that refusal — still no ingest. */
let afterRefusal: NowBody;
/** The first *now* that reported ingest live again. */
let resumed: NowBody;
/** A *now* read several segments into the second broadcast. */
let advanced: NowBody;
/** The lowest sequence any poll saw at each rung after the reconnect. */
const lowestAfterResume = new Map<string, number>();
/** The *now* once the second broadcaster had gone too. */
let settled: NowBody;

beforeAll(async () => {
  station = await boot();
  neverLive = (await readNow(await boot())).body;

  // ---- Live, with a window behind it ----

  const first = publish({ origin: station, streamKey: keyOf(station) });
  beforeDrop = await until(
    station,
    (now) =>
      now.live &&
      now.rungs.every((rung) => (rung.sequence ?? -1) >= HELD_SEGMENTS - 1),
    'the station never produced a window while the first broadcaster published'
  );

  // ---- The uplink goes ----

  // Killed outright rather than asked to stop: a broadcaster whose uplink dies
  // sends no goodbye, and an origin that only survives a clean disconnect has
  // survived the easy case.
  first.child.kill('SIGKILL');
  await first.done;

  dropped = await until(
    station,
    (now) => !now.live,
    'the station kept reporting ingest as live after the uplink died'
  );
  dropped = await still(station);

  // Everything the station holds at the moment of the drop, pulled the way a
  // viber pulls it. These bytes are the evidence for the sequence claim later.
  for (const rung of RUNGS) {
    const window = new Map<number, PulledSegment>();
    const edge = sequenceAt(dropped, rung);
    for (let sequence = edge - (HELD_SEGMENTS - 1); sequence <= edge;) {
      window.set(sequence, await pull(station, rung, sequence));
      sequence += 1;
    }
    held.set(rung, window);
  }

  // ---- A drop opens no door ----

  refused = await publish({
    origin: station,
    streamKey: `not-${keyOf(station)}`,
    seconds: 4,
  }).done;
  afterRefusal = await still(station);

  // ---- The broadcaster comes back ----

  const second = publish({ origin: station, streamKey: keyOf(station) });
  resumed = await until(
    station,
    (now) => now.live,
    'the station never accepted the broadcaster back'
  );

  for (const rung of RUNGS)
    lowestAfterResume.set(rung, Number.MAX_SAFE_INTEGER);
  advanced = await until(
    station,
    (now) => {
      for (const rung of now.rungs) {
        if (rung.sequence === null) continue;
        const lowest =
          lowestAfterResume.get(rung.rung) ?? Number.MAX_SAFE_INTEGER;
        lowestAfterResume.set(rung.rung, Math.min(lowest, rung.sequence));
      }
      return now.rungs.every(
        (rung) =>
          (rung.sequence ?? -1) >=
          sequenceAt(dropped, rung.rung) + HELD_SEGMENTS
      );
    },
    'the resumed broadcast never carried the edge past where the drop left it'
  );

  second.child.kill('SIGKILL');
  await second.done;
  await until(
    station,
    (now) => !now.live,
    'the station kept reporting ingest as live after the second uplink died'
  );
  settled = await still(station);
}, 300_000);

afterAll(async () => {
  for (const child of publishers.splice(0)) child.kill('SIGKILL');
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
  const dir = mkdtempSync(join(tmpdir(), 'station-reconnect-'));
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
 * Publish a generated broadcast at a station, exactly as a broadcaster's
 * software would — a URL, a stream key as the stream name, and `-re` so the
 * vibes arrive at the speed they were shot rather than as fast as the box can
 * encode them. The child is handed back so the suite can pull the plug on it
 * mid-broadcast, which is the whole point of this file.
 */
function publish(options: {
  origin: OriginInstance;
  streamKey: string;
  seconds?: number;
}): {
  child: ChildProcess;
  done: Promise<{ code: number | null; output: string }>;
} {
  const { origin, streamKey, seconds = BROADCAST_SECONDS } = options;
  const url = `rtmp://127.0.0.1:${String(origin.config.ingestPort)}/live/${streamKey}`;

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
    await new Promise((tick) => setTimeout(tick, 200));
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
    await new Promise((tick) => setTimeout(tick, 500));
  }
}

/** The window this suite held at the drop, at one rung. */
function heldAt(rung: string): Map<number, PulledSegment> {
  const window = held.get(rung);
  if (window === undefined) throw new Error(`nothing was held at "${rung}"`);
  return window;
}

// ---------- The tests ----------

describe('an ingest that drops mid-broadcast', () => {
  it('leaves every segment it had already produced servable', () => {
    for (const rung of RUNGS) {
      const window = heldAt(rung);
      expect(window.size).toBe(HELD_SEGMENTS);
      for (const [sequence, segment] of window) {
        expect({ rung, sequence, status: segment.status }).toEqual({
          rung,
          sequence,
          status: 200,
        });
        expect(segment.contentType).toBe('video/mp2t');
        expect(segment.body.length).toBeGreaterThan(0);
      }
    }
  });

  it('leaves the edge where the broadcast left it, not behind it', () => {
    for (const rung of RUNGS) {
      expect(sequenceAt(dropped, rung)).toBeGreaterThanOrEqual(
        sequenceAt(beforeDrop, rung)
      );
    }
  });

  it('reports no ingest, at the same address, rather than going missing', () => {
    expect(beforeDrop.live).toBe(true);
    expect(dropped.live).toBe(false);
    // Same station, same ladder, same span length — only the ingest is gone.
    expect(dropped.segmentSeconds).toBe(SEGMENT_SECONDS);
    expect(dropped.rungs.map((rung) => rung.rung)).toEqual(RUNGS);
  });

  it('is distinguishable from a station that never went live', () => {
    // Both say `live: false`. What separates them is the window: a station
    // mid-blip is holding vibes a viber can still buy, and one that never went
    // live is holding nothing — which is `null`, never `0`, because `0` is a
    // real segment somebody could pay for.
    expect(neverLive.live).toBe(false);
    expect(neverLive.rungs).toEqual([
      { rung: AUDIO_RUNG, sequence: null },
      { rung: VIDEO_RUNG, sequence: null },
    ]);

    expect(dropped.live).toBe(false);
    for (const rung of dropped.rungs) {
      expect(typeof rung.sequence).toBe('number');
      expect(rung.sequence).toBeGreaterThanOrEqual(HELD_SEGMENTS - 1);
    }
  });
});

describe('a station between broadcasters', () => {
  it('still refuses a publish carrying the wrong stream key', () => {
    // A drop is not an opening. The gate is the key, and it does not soften
    // because the station is quiet.
    expect(refused.code).not.toBe(0);
    expect(refused.output).toMatch(/denied|not valid|error/i);
  });

  it('does not report itself live because somebody knocked', () => {
    expect(afterRefusal.live).toBe(false);
  });

  it('keeps serving its window through the refusal', async () => {
    for (const rung of RUNGS) {
      for (const sequence of heldAt(rung).keys()) {
        const segment = await pull(station, rung, sequence);
        expect({ rung, sequence, status: segment.status }).toEqual({
          rung,
          sequence,
          status: 200,
        });
      }
    }
  });
});

describe('a broadcaster who reconnects', () => {
  it('is accepted, and the station reports ingest live again', () => {
    expect(resumed.live).toBe(true);
    expect(advanced.live).toBe(true);
    expect(advanced.segmentSeconds).toBe(SEGMENT_SECONDS);
    expect(advanced.rungs.map((rung) => rung.rung)).toEqual(RUNGS);
  });

  it('resumes the sequence rather than resetting it to zero', () => {
    for (const rung of RUNGS) {
      const edgeAtDrop = sequenceAt(dropped, rung);
      // Strictly past where the drop left it, by more than one segment — an
      // encoder that restarted at zero would climb back through these numbers
      // too, so the count alone is not the claim. The claim is the floor
      // below.
      expect(sequenceAt(advanced, rung)).toBeGreaterThan(edgeAtDrop);

      // And it never went back down. Every answer the suite read after the
      // reconnect named a sequence at or above the one the drop left behind,
      // so no viber watching the *now* was ever sent to the beginning.
      expect(lowestAfterResume.get(rung)).toBeGreaterThanOrEqual(edgeAtDrop);
    }
  });

  it('does not re-let an address a viber already paid for', async () => {
    // The strong form of the same claim, in bytes. An encoder that restarted
    // at zero would be serving different vibes at these sequences by now —
    // the same price, the same address, a different span.
    for (const rung of RUNGS) {
      for (const [sequence, before] of heldAt(rung)) {
        const after = await pull(station, rung, sequence);
        expect({ rung, sequence, status: after.status }).toEqual({
          rung,
          sequence,
          status: 200,
        });
        expect({
          rung,
          sequence,
          same: after.body.equals(before.body),
        }).toEqual({ rung, sequence, same: true });
      }
    }
  });

  it('serves one continuous window across the drop', async () => {
    // Both sides of the blip are reachable at the same address shape and the
    // same price: a viber who was mid-window walks straight through it.
    for (const rung of RUNGS) {
      const across = [
        Math.min(...heldAt(rung).keys()),
        sequenceAt(dropped, rung),
        sequenceAt(dropped, rung) + 1,
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

  it('takes the air back even when the origin never saw the drop', async () => {
    // The hard case, and the common one. A dropped uplink is usually not a
    // closed socket: the far end vanishes, the connection sits half-open, and
    // the broadcaster's software is back on a *fresh* one long before TCP
    // gives up on the old. So this test never closes the first connection at
    // all — it just reconnects over the top of it.
    const flaky = await boot();
    const stale = publish({ origin: flaky, streamKey: keyOf(flaky) });
    const before = await until(
      flaky,
      (now) =>
        now.live && now.rungs.every((rung) => (rung.sequence ?? -1) >= 1),
      'that station never went live'
    );

    // The reconnect, while the first connection is still open.
    const back = publish({ origin: flaky, streamKey: keyOf(flaky) });
    const resumedHere = await until(
      flaky,
      (now) =>
        now.rungs.every(
          (rung) => (rung.sequence ?? -1) > sequenceAt(before, rung.rung) + 1
        ),
      'the reconnect never carried the edge on'
    );
    expect(resumedHere.live).toBe(true);
    for (const rung of RUNGS) {
      expect(sequenceAt(resumedHere, rung)).toBeGreaterThan(
        sequenceAt(before, rung)
      );
    }

    // Now the reconnect goes too. The station is off the air — the first
    // connection lost it when the second was accepted, and its socket lingering
    // is not a broadcaster.
    back.child.kill('SIGKILL');
    await back.done;
    const quiet = await until(
      flaky,
      (now) => !now.live,
      'the station reported ingest live on the strength of a connection that had already lost the air'
    );
    expect(quiet.live).toBe(false);

    // And the window survived both of them.
    for (const rung of RUNGS) {
      const segment = await pull(flaky, rung, sequenceAt(before, rung));
      expect({ rung, status: segment.status }).toEqual({ rung, status: 200 });
    }

    stale.child.kill('SIGKILL');
    await stale.done;
  }, 180_000);

  it('goes quiet again when the second uplink dies, without losing the window', async () => {
    expect(settled.live).toBe(false);
    for (const rung of RUNGS) {
      expect(sequenceAt(settled, rung)).toBeGreaterThanOrEqual(
        sequenceAt(advanced, rung)
      );
      const segment = await pull(station, rung, sequenceAt(settled, rung));
      expect({ rung, status: segment.status }).toEqual({ rung, status: 200 });
    }
  });
});
