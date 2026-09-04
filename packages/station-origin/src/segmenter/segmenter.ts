/**
 * The segmenter: what turns a broadcaster's vibes into things a viber can buy.
 *
 * A publish arrives as one long FLV byte stream and a viber cannot pay for
 * "the broadcast" — they pay for a span, one at a time, and stop paying the
 * moment they stop pulling. So the origin supervises a child `ffmpeg` that
 * re-encodes the incoming vibes at a rung and cuts them into fixed-duration
 * segments, each of which is a self-contained, independently playable span
 * with a sequence number.
 *
 * The origin owns its encoder rather than depending on a separately-scheduled
 * one, which is what keeps ingest, encoding and serving inside a single
 * testable surface.
 *
 * Three properties are the whole point of this module:
 *
 *   - **A segment arrives whole or not at all.** `ffmpeg` writes each segment
 *     to a temporary name and renames it only once the span is complete, and
 *     nothing is indexed — and so nothing is servable — until that rename has
 *     happened. A viber pays once for a span they can actually play, never for
 *     a truncated one.
 *
 *   - **A segment is bounded in bytes.** The bound is the arithmetic: a hard
 *     bitrate cap times a fixed duration. The measurement here is the alarm
 *     for an encoder that misbehaves anyway — a segment over
 *     {@link SEGMENT_BYTE_BUDGET} is logged loudly and never served, because a
 *     segment that cannot come back in one fulfill is worse than a missing one.
 *
 *   - **Sequence numbers continue.** The next segment's number is read off
 *     what is already on disk, so a re-encode picks up where the last one
 *     stopped rather than restarting at zero and serving different vibes at an
 *     address a viber has already paid for.
 *
 * What this module does not do: it does not evict (issue #10) and it holds no
 * payment code of any kind. It does not decide when a broadcast has dropped
 * either — that is the ingest listener's judgement, and this module simply
 * cuts whatever publish is handed to it, picking up the sequence where the
 * last one left off. It is where the station's *now* is read from — `latest()` is one
 * rung's live edge — but the address that reports it is `../now/now.ts`.
 *
 * Generated media lives under `<dataDir>/segments/<rung>/` — ignored by
 * **directory**, never by extension, because an HLS segment is an MPEG-TS
 * `.ts` file and a `*.ts` ignore rule would swallow this file too. Which is
 * also why this module sits in `src/segmenter/` and not `src/segments/`: the
 * ignore rule matches a directory of that name anywhere, source included.
 *
 * @module
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { assertLadder } from './ladder.js';
import {
  hasVideo,
  SEGMENT_BYTE_BUDGET,
  VBV_BUFFER_SECONDS,
  type Rung,
} from './rung.js';

/**
 * How often a running encoder's output directory is checked for a finished
 * segment, in milliseconds.
 *
 * Polled rather than watched: a poll is one `stat` of the single file the
 * encoder is expected to finish next, which costs less than a directory watch
 * and cannot miss an event. The interval runs only while an encoder is alive.
 */
const POLL_INTERVAL_MS = 200;

/**
 * The quality `-crf` spends bits toward *underneath* the hard cap.
 *
 * Constrained VBR is a quality target plus a ceiling: easy vibes come back
 * smaller than the ceiling, busy ones are held to it. 23 is x264's default and
 * is a placeholder like every other number in this repo.
 */
const CRF = 23;

/** How long a stopped encoder is given to exit before it is killed outright. */
const ENCODER_STOP_GRACE_MS = 2_000;

/** One finished segment: a span of vibes at a rung, addressable by sequence. */
export interface Segment {
  /** The rung it was encoded at. */
  rung: string;
  /** Its sequence number, which is the second half of its address. */
  sequence: number;
  /** Its size in actual encoded bytes. */
  bytes: number;
  /** When the origin first saw it finished, in epoch milliseconds. */
  producedAt: number;
}

/**
 * The answer to "give me this segment".
 *
 * A rung the station does not offer and a sequence it does not have are
 * distinguishable outcomes, not one shrug: a viber whose rung is gone falls
 * back to one that exists, and a viber whose sequence is gone re-syncs to the
 * live edge. Collapsing them would make both look like the other.
 */
export type SegmentLookup =
  | { outcome: 'ok'; segment: Segment; body: Buffer }
  | { outcome: 'unknown-rung' }
  | { outcome: 'unknown-segment' };

/** Configuration for {@link createSegmenter}. */
export interface SegmenterConfig {
  /** The origin's data directory. Segments are written beneath it. */
  dataDir: string;
  /**
   * The ladder this station offers: every rung one ingest is encoded at, each
   * served beneath its own prefix at its own price.
   */
  rungs: readonly Rung[];
  /** Fixed segment duration, in seconds. */
  segmentSeconds: number;
  /** The `ffmpeg` binary to supervise (default: `ffmpeg`, found on PATH). */
  ffmpegPath?: string;
}

/** A segmenter, ready to cut whatever ingest hands it. */
export interface SegmenterInstance {
  /** The rungs this station offers, in ladder order. */
  readonly rungs: readonly Rung[];
  /** The fixed duration every segment covers, in seconds. */
  readonly segmentSeconds: number;
  /** Whether this station offers a rung by that name. */
  hasRung(rung: string): boolean;
  /**
   * Start cutting a publish. Any encoder still running from an earlier publish
   * is stopped first — two encoders writing the same sequence numbers would
   * serve two different spans at one address.
   */
  cut(vibes: Readable): void;
  /** The latest finished segment at a rung, if there is one. */
  latest(rung: string): Segment | undefined;
  /** Read one segment whole, or say why it cannot be served. */
  read(rung: string, sequence: number): Promise<SegmentLookup>;
  /** Stop every encoder and release its resources. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Create a segmenter over a data directory.
 *
 * Creates each rung's directory and indexes whatever finished segments it
 * already holds, so a restarted origin keeps serving the window it had and
 * numbers the next segment after the last one it produced.
 *
 * @throws RungError if a rung cannot be addressed, if two rungs share a name,
 * if the duration is unusable, or if a rung's capped bitrate times that
 * duration exceeds the byte budget of ADR 0001.
 */
export function createSegmenter(config: SegmenterConfig): SegmenterInstance {
  const { dataDir, segmentSeconds } = config;
  const rungs = [...config.rungs];
  const ffmpegPath = config.ffmpegPath ?? 'ffmpeg';

  // The whole ladder, before a directory is created or an encoder spawned.
  // The byte-budget arithmetic is re-run here on every start, so a bitrate
  // raised between runs is refused at the next one rather than quietly served.
  assertLadder(rungs, segmentSeconds);

  const tracks = new Map<string, RungTrack>();
  for (const rung of rungs) {
    const directory = join(dataDir, 'segments', rung.name);
    mkdirSync(directory, { recursive: true });
    const track: RungTrack = {
      rung,
      directory,
      segments: new Map<number, Segment>(),
      next: 0,
      latest: undefined,
    };
    // Whatever a previous run left behind is already finished and already
    // paid-for-able. Indexing it is what makes a restart continue rather than
    // start over at sequence zero.
    sweep(track);
    tracks.set(rung.name, track);
  }

  let encoders: Encoder[] = [];
  let poll: NodeJS.Timeout | undefined;
  let running = true;
  /**
   * The queue every `cut()` goes through.
   *
   * Stopping an encoder is asynchronous — it is given a moment to flush the
   * span it holds — so two publishes arriving inside that moment would
   * otherwise interleave: the second would find no encoders to stop, start its
   * own, and then the first would start a second set on top. Two encoders
   * writing one rung's directory means two different spans claiming one
   * sequence number, at an address a viber has already paid for. A flapping
   * uplink reconnecting twice in a second is exactly that case, so the
   * handovers are made to queue rather than to race.
   */
  let handovers: Promise<void> = Promise.resolve();

  return {
    rungs,
    segmentSeconds,

    hasRung(rung) {
      return tracks.has(rung);
    },

    cut(vibes) {
      if (!running) return;

      // Held explicitly, not incidentally: an earlier encoder still holding a
      // sequence number has to let go before a new one claims it, and an
      // explicit pause is also what stops anything else that attaches to these
      // vibes from starting them flowing past us in the meantime.
      vibes.pause();

      handovers = handovers.then(async () => {
        await stopEncoders();
        if (!running) return;

        // Each new encoder starts at the sequence the last one stopped at,
        // read off what is on disk rather than kept in memory. That is what
        // makes a reconnect a continuation: a broadcaster with a flaky uplink
        // resumes the broadcast instead of starting it over, and a viber who
        // was mid-window is not thrown back to the beginning.
        encoders = rungs.map((rung) => {
          const track = tracks.get(rung.name);
          /* c8 ignore next */
          if (track === undefined) throw new Error(`no track for ${rung.name}`);
          return startEncoder(track);
        });

        for (const encoder of encoders) {
          // Piped, not copied: `pipe` wires the publisher's backpressure
          // through to the encoder, so an encoder that falls behind slows the
          // broadcaster down instead of growing a buffer until the node runs
          // out of memory.
          vibes.pipe(encoder.child.stdin);
        }

        startPolling();
      });
      // A failed handover must not wedge the queue: the next publish still has
      // to be able to take the air.
      handovers = handovers.catch((error: unknown) => {
        console.error(
          `[station-origin] could not hand the encoders over to a new publish: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    },

    latest(rung) {
      return tracks.get(rung)?.latest;
    },

    async read(rung, sequence) {
      const track = tracks.get(rung);
      if (track === undefined) return { outcome: 'unknown-rung' };

      const segment = track.segments.get(sequence);
      if (segment === undefined) return { outcome: 'unknown-segment' };

      try {
        const body = await readFile(join(track.directory, `${sequence}.ts`));
        // The file is only indexed once it has been renamed into place, so a
        // short read here means it went away underneath us rather than that it
        // is still being written. Either way, a viber gets a clean miss rather
        // than a truncated span they paid for.
        if (body.length !== segment.bytes) {
          track.segments.delete(sequence);
          return { outcome: 'unknown-segment' };
        }
        return { outcome: 'ok', segment, body };
      } catch {
        track.segments.delete(sequence);
        return { outcome: 'unknown-segment' };
      }
    },

    async stop() {
      if (!running) return;
      running = false;
      // After the queue, so an encoder a handover was midway through starting
      // is stopped rather than left running behind a stopped segmenter.
      await handovers;
      stopPolling();
      await stopEncoders();
    },
  };

  // ---------- The encoder ----------

  function startEncoder(track: RungTrack): Encoder {
    const child = spawn(
      ffmpegPath,
      encoderArgs(track.rung, segmentSeconds, track.directory, track.next),
      { stdio: 'pipe' }
    );

    // A broadcaster who disconnects, or an encoder that dies, breaks this pipe.
    // That is an ordinary end to a publish, not a reason to take the node down.
    child.stdin.on('error', () => undefined);
    // ffmpeg says nothing on stdout with these arguments, but an unread pipe
    // that filled would block the encoder mid-segment.
    child.stdout.resume();

    let complaints = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      complaints = `${complaints}${chunk}`.slice(-2000);
    });

    child.on('error', (error) => {
      console.error(
        `[station-origin] could not run the encoder for rung "${track.rung.name}": ${error.message}`
      );
    });

    const encoder: Encoder = { child, track, stopping: false };

    child.on('close', (code, signal) => {
      // The last span is renamed into place as the encoder exits, so sweep
      // once more before deciding there is nothing new.
      sweep(track);
      // An encoder we asked to stop is not an encoder that failed, however it
      // chose to report the interruption.
      if (encoder.stopping || signal !== null || code === 0) return;
      console.error(
        `[station-origin] the encoder for rung "${track.rung.name}" exited with code ${String(code)}${
          complaints === '' ? '' : `: ${complaints.trim()}`
        }`
      );
    });

    console.log(
      `[station-origin] encoding rung "${track.rung.name}" into ${String(segmentSeconds)}s segments from sequence ${String(track.next)}`
    );

    return encoder;
  }

  async function stopEncoders(): Promise<void> {
    const stopping = encoders;
    encoders = [];
    await Promise.all(stopping.map((encoder) => stopEncoder(encoder)));
    stopPollingIfIdle();
  }

  function stopEncoder(encoder: Encoder): Promise<void> {
    const { child, track } = encoder;
    encoder.stopping = true;
    if (child.exitCode !== null || child.signalCode !== null) {
      sweep(track);
      return Promise.resolve();
    }
    return new Promise<void>((resolveStop) => {
      const kill = setTimeout(
        () => child.kill('SIGKILL'),
        ENCODER_STOP_GRACE_MS
      );
      child.once('close', () => {
        clearTimeout(kill);
        sweep(track);
        resolveStop();
      });
      // SIGTERM first: ffmpeg flushes the span it is holding and renames it
      // into place, so the last segment a broadcaster produced is servable.
      child.kill('SIGTERM');
    });
  }

  // ---------- Noticing finished segments ----------

  function startPolling(): void {
    if (poll !== undefined) return;
    poll = setInterval(() => {
      for (const track of tracks.values()) sweep(track);
      stopPollingIfIdle();
    }, POLL_INTERVAL_MS);
    // A poll is bookkeeping, not work the node should stay alive for.
    poll.unref();
  }

  function stopPolling(): void {
    if (poll === undefined) return;
    clearInterval(poll);
    poll = undefined;
  }

  function stopPollingIfIdle(): void {
    if (encoders.some((encoder) => encoder.child.exitCode === null)) return;
    stopPolling();
  }
}

/** One rung's encoder and the track it writes into. */
interface Encoder {
  child: ChildProcessWithoutNullStreams;
  track: RungTrack;
  /** Whether the origin asked this encoder to stop, rather than it dying. */
  stopping: boolean;
}

/** Everything the origin knows about one rung's output. */
interface RungTrack {
  rung: Rung;
  directory: string;
  segments: Map<number, Segment>;
  /** The sequence number the encoder is expected to finish next. */
  next: number;
  latest: Segment | undefined;
}

/**
 * Index every segment that has finished since the last look.
 *
 * The encoder writes each span to a temporary name and renames it into place
 * only when the span is complete, and it numbers them consecutively — so
 * "has the next one appeared" is a single `stat`, and a file that has appeared
 * is by construction whole.
 */
function sweep(track: RungTrack): void {
  for (;;) {
    const sequence = track.next;
    let bytes: number;
    try {
      bytes = statSync(join(track.directory, `${sequence}.ts`)).size;
    } catch {
      return;
    }
    track.next = sequence + 1;

    if (bytes === 0) continue;
    if (bytes > SEGMENT_BYTE_BUDGET) {
      // The arithmetic is the guarantee; this is the alarm for an encoder that
      // broke it anyway. Serving it would hand a viber a span their connector
      // may refuse to carry, having already charged them for asking.
      console.error(
        `[station-origin] rung "${track.rung.name}" produced sequence ${String(sequence)} at ${String(bytes)} bytes, over the ${String(SEGMENT_BYTE_BUDGET)}-byte budget (ADR 0001) — it will not be served; lower the rung's bitrate or shorten the segment`
      );
      continue;
    }

    const segment: Segment = {
      rung: track.rung.name,
      sequence,
      bytes,
      producedAt: Date.now(),
    };
    track.segments.set(sequence, segment);
    track.latest = segment;
  }
}

/**
 * The encoder invocation.
 *
 * Nothing outside this module may depend on the shape of these arguments —
 * no test reaches them, and how the origin encodes must stay rewritable. What
 * is load-bearing is what they *mean*:
 *
 *   - `-crf` with `-maxrate`/`-bufsize` and deliberately **no** `-b:v` is
 *     constrained VBR. `-b:v` would target an average and overshoot on busy
 *     vibes; the cap here is a ceiling the encoder may not cross, which is what
 *     makes cap × duration a bound rather than an expectation.
 *   - `-force_key_frames` puts a keyframe at every segment boundary, so each
 *     segment decodes on its own and a viber who joins mid-broadcast can play
 *     the first one they buy.
 *   - a rung with no picture drops the video stream outright rather than
 *     encoding one nobody asked for. It is the cheapest rung on the shipped
 *     ladder, and what makes it cheap is that the bytes are not there.
 *   - `temp_file` is what makes a segment arrive whole: each span is written
 *     under a temporary name and renamed only once it is complete.
 *   - `-start_number` continues the sequence rather than restarting it.
 *
 * The playlist the HLS muxer insists on writing is a side effect, not a
 * surface: no playlist is served from a station, because nothing free is
 * served from a station and the client daemon synthesizes whatever its player
 * needs over loopback.
 */
function encoderArgs(
  rung: Rung,
  segmentSeconds: number,
  directory: string,
  startNumber: number
): string[] {
  const video = hasVideo(rung)
    ? [
        // Optional map: a broadcaster who sent no picture is still a station.
        '-map',
        '0:v:0?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-profile:v',
        'main',
        '-pix_fmt',
        'yuv420p',
        // Down to the rung's height, never up: vibes that arrived smaller than
        // the rung are passed through at their own size rather than inflated.
        '-vf',
        `scale=-2:2*trunc(min(${String(rung.height)}\\,ih)/2)`,
        '-crf',
        String(CRF),
        '-maxrate',
        String(rung.videoBitrate),
        '-bufsize',
        String(rung.videoBitrate * VBV_BUFFER_SECONDS),
        '-force_key_frames',
        `expr:gte(t,n_forced*${String(segmentSeconds)})`,
      ]
    : ['-vn'];

  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',

    // The broadcaster's vibes, as FLV on a pipe.
    '-f',
    'flv',
    '-i',
    'pipe:0',

    // Video, at a hard cap — or none at all, on a rung that is sound only.
    ...video,

    // Audio.
    '-map',
    '0:a:0?',
    '-c:a',
    'aac',
    '-b:a',
    String(rung.audioBitrate),
    '-ar',
    '48000',

    // Fixed-duration MPEG-TS segments, whole or absent.
    '-f',
    'hls',
    '-hls_time',
    String(segmentSeconds),
    '-hls_list_size',
    '5',
    '-hls_flags',
    'temp_file+independent_segments+omit_endlist',
    '-hls_segment_type',
    'mpegts',
    '-hls_segment_filename',
    join(directory, '%d.ts'),
    '-start_number',
    String(startNumber),
    join(directory, 'index.m3u8'),
  ];
}
