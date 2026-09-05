/**
 * A broadcaster's vibes, going in.
 *
 * A generated test pattern is published into the station's ingest over RTMP,
 * with **the ffmpeg inside the station origin's own image** — so the devnet
 * introduces no image to encode with, and the encoder a run pushes through is
 * the encoder a station ships.
 *
 * It runs as its own container on the compose network rather than inside the
 * origin's, because a broadcaster's uplink is not part of their origin: it
 * dials `rtmp://station-origin:1935/live/<stream key>`, which is exactly the
 * Server/Stream Key pair OBS asks for, and the origin checks that key on the
 * RTMP `publish` command before a byte is transcoded.
 *
 * Plain RTMP, not RTMPS: there is no certificate in a laptop topology, the
 * origin says so loudly at boot, and the whole exchange happens on a private
 * compose network. On a box with a public name it would put the stream key on
 * the wire in clear, which is why the shipped station bundle mounts one.
 */

import { compose } from './compose.js';

/** The origin's own service, whose image carries the encoder. */
const ORIGIN_SERVICE = 'station-origin';

/** The uplink container, named so a run can find it, stop it and read its log. */
export const UPLINK_CONTAINER = 'devnet-uplink';

/**
 * The pattern a run broadcasts.
 *
 * `testsrc2` and `sine` are ffmpeg's own generators, so nothing has to be
 * committed as media — and a moving picture with a tone under it is what makes
 * a segment's bytes something other than a run of zeroes.
 *
 * `-re` paces the push at real time, which is what a live station is: without
 * it ffmpeg would deliver an hour of vibes as fast as the socket takes them
 * and the station's *now* would sprint past every sequence a viber could pay
 * for.
 *
 * The bitrates sit under the devnet ladder's own caps, so the origin's encoders
 * have something to work from rather than something to refuse.
 */
function uplinkArguments(streamKey: string): string[] {
  return [
    '-loglevel',
    'warning',
    '-re',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    // A keyframe every second, so the origin can cut a segment anywhere its
    // fixed duration falls rather than waiting on the next one.
    '-g',
    '25',
    '-b:v',
    '600k',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-f',
    'flv',
    `rtmp://${ORIGIN_SERVICE}:1935/live/${streamKey}`,
  ];
}

/**
 * Start the broadcaster's uplink, detached, and leave it running.
 *
 * `--no-deps`, because the origin is already up and this container wants
 * nothing else started on its behalf; no published port, because a broadcaster
 * pushing vibes listens for nothing.
 */
export async function startBroadcasting(streamKey: string): Promise<void> {
  await compose([
    'run',
    '--detach',
    '--no-deps',
    '--name',
    UPLINK_CONTAINER,
    '--entrypoint',
    'ffmpeg',
    ORIGIN_SERVICE,
    ...uplinkArguments(streamKey),
  ]);
}

/** The station's own report of where its live edge is, from inside the node. */
export interface StationNow {
  live: boolean;
  segmentSeconds: number;
  rungs: { rung: string; sequence: number | null }[];
}

/**
 * Ask the origin directly where its live edge is.
 *
 * `/now` is a PAID address through the connector — that is what #60 buys — but
 * it also answers on the segment port, which is published on no interface and
 * reachable only from inside the node. A run asks it that way for the same
 * reason a broadcaster-operator does: to know what the station holds, without
 * paying for the answer and without it being the thing under test.
 */
export async function stationNow(): Promise<StationNow> {
  const { stdout } = await compose([
    'exec',
    '-T',
    ORIGIN_SERVICE,
    'wget',
    '-qO-',
    'http://127.0.0.1:3100/now',
  ]);
  return JSON.parse(stdout) as StationNow;
}

/**
 * Wait until every rung holds a segment somebody could pay for.
 *
 * A station's first segments do not exist the instant its uplink connects: the
 * encoders have to fill a fixed span before there is one to cut. A run that
 * asked for a sequence before then would be asking for something that has
 * never existed, which is a different failure from the one it is testing.
 *
 * `sequence` is `null` when a rung holds nothing, and never `0` — which is a
 * real segment somebody could pay for.
 */
export async function waitForVibes(options: {
  rungs: string[];
  timeoutMs: number;
}): Promise<StationNow> {
  const deadline = Date.now() + options.timeoutMs;
  let last: StationNow | undefined;

  for (;;) {
    last = await stationNow();
    const holding = last.rungs.filter((rung) => rung.sequence !== null);
    if (
      last.live &&
      options.rungs.every((rung) => holding.some((held) => held.rung === rung))
    ) {
      return last;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the station never held a segment at every one of ${JSON.stringify(options.rungs)} — its own *now* says ${JSON.stringify(last)}. Either the uplink never arrived (the stream key, or the ingest port) or the encoder never produced a span.`
      );
    }
    await new Promise((waited) => setTimeout(waited, 1_000));
  }
}
