/**
 * Pace: whether the encode is keeping up with the ladder it was given.
 *
 * A broadcaster who points OBS at a station and sees a stuttering picture has
 * two suspects and no way to tell them apart from the outside — *my box is not
 * big enough for the ladder I chose* and *my uplink is bad* look identical to
 * a viber and to the broadcaster. This module is the measurement that separates
 * them, and it is measured **at the boundary of the real encoder**: the clock,
 * and the segments that have actually finished. Nothing here inspects
 * `ffmpeg`, parses its output, or asks it how it is doing.
 *
 * The arithmetic is one line and deliberately so. A live broadcast arrives in
 * real time, so a station that is keeping up has, at any moment, finished
 * about as many seconds of vibes as seconds have passed since the encoder
 * started. Falling behind is the gap between those two growing:
 *
 * ```
 * behind = elapsed − encoded − (the span the encoder is working on)
 * ```
 *
 * Two segments of slack are built in and each is there for a reason. The span
 * in flight has not finished yet and is not lateness — subtracting one segment
 * is what keeps a healthy encoder reading `0` rather than sawtoothing between
 * `0` and one segment. {@link lagToleranceSeconds} more absorbs the encoder's
 * own start-up, its flush, and the interval the origin notices a finished
 * segment on. Past that, the gap only grows if the box cannot encode this
 * ladder in real time, which is the thing a broadcaster wants told.
 *
 * **Per rung, because that is what makes the answer actionable.** One ingest is
 * encoded at every rung at once. A cheap rung that keeps pace while an
 * expensive one falls behind is a ladder that is too ambitious for this box —
 * drop the top rung. Every rung falling behind together, with ingest live, is
 * the same verdict on the whole ladder. Nothing falling behind while the edge
 * stops moving is not the encode at all; that is `live` going false, and it is
 * the uplink.
 *
 * A run is one publish: it starts when the encoder does and freezes when that
 * encoder stops, so a broadcaster who has finished can still read what their
 * box did rather than finding the answer erased along with the broadcast.
 *
 * @module
 */

/**
 * Segments of slack a rung is allowed beyond the span in flight before it is
 * called behind.
 *
 * One whole segment, which is generous on purpose: the alarm is for a box that
 * genuinely cannot keep up, and a report that cried wolf at every encoder
 * start-up would be one a broadcaster learned to ignore.
 */
export const LAG_TOLERANCE_SEGMENTS = 1;

/**
 * The least slack a rung is allowed, in seconds, however short its segments
 * are.
 *
 * An encoder's start-up costs about the same second whether it is cutting
 * one-second segments or eight-second ones, so slack expressed only in
 * segments would call a station on a short ladder behind every time a
 * broadcaster connected. Observed rather than guessed: a station cutting
 * one-second segments takes a little over two seconds to finish its first one,
 * and has lost nothing at all by then.
 */
export const LAG_TOLERANCE_FLOOR_SECONDS = 2;

/** How much a rung may fall behind, at this segment duration, before it is behind. */
export function lagToleranceSeconds(segmentSeconds: number): number {
  return Math.max(
    LAG_TOLERANCE_SEGMENTS * segmentSeconds,
    LAG_TOLERANCE_FLOOR_SECONDS
  );
}

/** One publish, as the encoder for one rung lived it. */
export interface EncodeRun {
  /** When this rung's encoder started, in epoch milliseconds. */
  startedAt: number;
  /**
   * When it stopped, in epoch milliseconds — absent while it is still
   * running. Set, the pace stops moving: what is reported afterwards is what
   * the box did, not what it is doing.
   */
  endedAt?: number | undefined;
  /**
   * How many segments this run has finished, **including any refused for
   * being over the byte budget**. A segment the origin will not serve still
   * cost the encoder its span of real time, so counting it is what keeps this
   * a measurement of the encode rather than of what happened to be servable.
   */
  segments: number;
}

/** How one rung's encode is doing, measured rather than assumed. */
export interface RungPace {
  /** The rung, by the name that also appears in its address. */
  rung: string;
  /** Whether an encoder is running for this rung right now. */
  encoding: boolean;
  /**
   * Whether the encode is keeping pace with ingest, or `null` when this rung
   * has never encoded anything and there is nothing to judge — deliberately
   * not `true`, which would report a station that has never been broadcast to
   * as healthy.
   */
  keepingUp: boolean | null;
  /**
   * How many seconds behind real time the encode is, or `null` when there is
   * no run to measure. `0` while it keeps pace; growing is the alarm.
   */
  behindSeconds: number | null;
  /** Seconds of vibes finished in this run — segments × the fixed duration. */
  encodedSeconds: number;
  /** Seconds of real time this run has been, or was, encoding. */
  elapsedSeconds: number;
}

/** A segment the encoder produced that the origin will not serve. */
export interface OverBudgetSegment {
  /** Its sequence number, so a broadcaster can find it. */
  sequence: number;
  /** What it actually measured, in bytes — over the budget of ADR 0001. */
  bytes: number;
}

/**
 * How one rung's encode is doing, in full: the pace it is keeping and what its
 * segments actually measured.
 *
 * The two halves answer different questions and both are the broadcaster's.
 * The pace says whether this box can encode this ladder in real time. The
 * bytes are the alarm the arithmetic cannot raise on its own: a rung's capped
 * bitrate times the fixed duration is a *guarantee* checked at boot, and these
 * fields are what a broadcaster reads when the encoder broke it anyway.
 */
export interface RungEncode extends RungPace {
  /**
   * How many segments at this rung have been refused for exceeding the byte
   * budget since the origin started. Above zero, this station is producing
   * spans a viber's connector may not be able to carry — and the origin is
   * throwing them away rather than serving them.
   */
  refusedOverBudget: number;
  /** The last segment refused that way, or `null` if none ever was. */
  lastOverBudget: OverBudgetSegment | null;
  /**
   * The largest segment this rung has produced since the origin started,
   * **whether or not it was servable**, in bytes — or `null` if it has
   * produced none. Measured, never computed: this is what makes the byte
   * budget an observation rather than a restatement of the arithmetic.
   */
  largestSegmentBytes: number | null;
}

/** Everything {@link paceOf} needs to judge one rung. */
export interface PaceInput {
  /** The rung being judged. */
  rung: string;
  /** Its current or last run, or `undefined` if it has never encoded. */
  run: EncodeRun | undefined;
  /** The station's fixed segment duration, in seconds. */
  segmentSeconds: number;
  /** The clock, injected so the arithmetic is a pure function of its inputs. */
  now?: number;
}

/**
 * Measure one rung's pace.
 *
 * Pure: the same inputs give the same answer, and the only thing it knows
 * about the encoder is when it started and how many segments have appeared
 * since. Seconds are rounded to a tenth, which is the resolution a broadcaster
 * reads and well inside the noise of a poll interval.
 */
export function paceOf(input: PaceInput): RungPace {
  const { rung, run, segmentSeconds } = input;

  if (run === undefined) {
    return {
      rung,
      encoding: false,
      keepingUp: null,
      behindSeconds: null,
      encodedSeconds: 0,
      elapsedSeconds: 0,
    };
  }

  const at = run.endedAt ?? input.now ?? Date.now();
  const elapsedSeconds = Math.max(0, (at - run.startedAt) / 1000);
  const encodedSeconds = run.segments * segmentSeconds;

  // The span the encoder is holding has not finished and is not lateness.
  const behindSeconds = Math.max(
    0,
    elapsedSeconds - encodedSeconds - segmentSeconds
  );

  return {
    rung,
    encoding: run.endedAt === undefined,
    keepingUp: behindSeconds <= lagToleranceSeconds(segmentSeconds),
    behindSeconds: tenths(behindSeconds),
    encodedSeconds: tenths(encodedSeconds),
    elapsedSeconds: tenths(elapsedSeconds),
  };
}

/** Seconds, to a tenth. */
function tenths(seconds: number): number {
  return Math.round(seconds * 10) / 10;
}
