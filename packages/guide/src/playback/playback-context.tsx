/**
 * One poll of the playback contract for the whole guide — detection and
 * state in a single seam, the way the stations provider is one relay
 * subscription.
 *
 * Hybrid by detection (epic #72): the provider asks the loopback surface for
 * its state on a cadence. An answer means a paying side is there and live
 * playback lights up; no answer means the hosted mode, where the same
 * affordances explain how to vibe instead. Detection is only ever a read —
 * a guide that cannot reach the contract has nothing to apologise for, and
 * keeps probing so a paying side started later lights the page up without a
 * reload.
 *
 * The actions are the contract's three writes and no more: vibe, stop,
 * select a rung. Each absorbs the state the write answers with, so the UI
 * follows a click immediately rather than waiting out a poll. No budget is
 * ever sent — the budget is the paying side's own, readable in the state and
 * settable from nowhere here (ADR 0005).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  readPlaybackState,
  requestRung,
  requestStop,
  requestVibe,
  type PlaybackState,
} from '@/playback/playback';

/**
 * How often the state is re-read. While vibing this is what keeps the spend
 * honest on screen; while absent it is the detector's patience.
 */
const POLL_MS = 1_000;

export interface PlaybackView {
  /** The paying side's state, or `null` when none is detected — hosted mode. */
  state: PlaybackState | null;
  /** Initiate vibing with a station, by its address. */
  vibe: (station: string) => void;
  /** Stop vibing, which stops the spend. */
  stop: () => void;
  /** Select the rung to vibe at — a choice within the paying side's budget. */
  selectRung: (rung: string) => void;
}

const PlaybackContext = createContext<PlaybackView>({
  state: null,
  vibe: () => undefined,
  stop: () => undefined,
  selectRung: () => undefined,
});

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PlaybackState | null>(null);
  /** One read in flight at a time — a slow answer must not stack polls. */
  const inFlight = useRef(false);

  useEffect(() => {
    let standing = true;

    const poll = async (): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      const read = await readPlaybackState();
      inFlight.current = false;
      if (standing) setState(read);
    };

    void poll();
    const cadence = setInterval(() => void poll(), POLL_MS);
    return () => {
      standing = false;
      clearInterval(cadence);
    };
  }, []);

  const absorb = useCallback((answered: PlaybackState | null) => {
    if (answered !== null) setState(answered);
  }, []);

  const vibe = useCallback(
    (station: string) => {
      void requestVibe(station).then(absorb);
    },
    [absorb]
  );
  const stop = useCallback(() => {
    void requestStop().then(absorb);
  }, [absorb]);
  const selectRung = useCallback(
    (rung: string) => {
      void requestRung(rung).then(absorb);
    },
    [absorb]
  );

  return (
    <PlaybackContext.Provider value={{ state, vibe, stop, selectRung }}>
      {children}
    </PlaybackContext.Provider>
  );
}

/** The paying side as this guide currently sees it — the routes' one read. */
export function usePlayback(): PlaybackView {
  return useContext(PlaybackContext);
}
