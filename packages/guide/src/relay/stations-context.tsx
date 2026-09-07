/**
 * One relay subscription for the whole guide, and the clock that keeps
 * liveness honest.
 *
 * The provider opens a single NIP-01 subscription to the configured relay
 * for the three discovery kinds, absorbs events under replaceable
 * semantics, and re-derives the station list when anything stands anew. It
 * also ticks a coarse clock, because a live badge is a claim about *now*: a
 * heartbeat that lapses while the page sits open must drop the badge with
 * no reload, and re-evaluating NIP-40 expiry against a ticking `nowSeconds`
 * is exactly that.
 *
 * This context is the seam the other routes consume — the broadcaster page
 * and the category views read the same stations. Clips (kind 1063) ride the
 * same reader with an author filter, but not this provider: they are one
 * broadcaster's, so the broadcaster page opens its own subscription.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { RELAY_URL } from '@/relay/relay-url';
import { subscribeToRelay } from '@/relay/nip01';
import {
  absorb,
  type AnnouncementLog,
  HEARTBEAT_KIND,
  PROFILE_KIND,
  STATION_ANNOUNCEMENT_KIND,
} from '@/relay/announcements';
import { isLive, stationsFrom, type Station } from '@/relay/stations';

/** How often liveness is re-asked. Heartbeat expiries are tens of seconds. */
const CLOCK_TICK_MS = 1_000;

export interface StationsView {
  /** Every announced station, deduplicated, oldest claim first. */
  stations: Station[];
  /** The subset with an unexpired heartbeat — who is on the air right now. */
  live: Station[];
  /** The clock liveness was last evaluated against, unix seconds. */
  nowSeconds: number;
}

const StationsContext = createContext<StationsView>({
  stations: [],
  live: [],
  nowSeconds: 0,
});

export function StationsProvider({ children }: { children: ReactNode }) {
  const log = useRef<AnnouncementLog>(new Map());
  const [revision, setRevision] = useState(0);
  const [nowSeconds, setNowSeconds] = useState(() =>
    Math.floor(Date.now() / 1000)
  );

  useEffect(() => {
    const subscription = subscribeToRelay(
      RELAY_URL,
      [PROFILE_KIND, STATION_ANNOUNCEMENT_KIND, HEARTBEAT_KIND],
      (event) => {
        if (absorb(log.current, event)) {
          setRevision((standing) => standing + 1);
        }
      }
    );
    return () => {
      subscription.close();
    };
  }, []);

  useEffect(() => {
    const clock = setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, CLOCK_TICK_MS);
    return () => {
      clearInterval(clock);
    };
  }, []);

  // The log is a mutable ref; the revision is what says it changed.
  const stations = useMemo(() => stationsFrom(log.current), [revision]);

  const view = useMemo(
    () => ({
      stations,
      live: stations.filter((station) => isLive(station, nowSeconds)),
      nowSeconds,
    }),
    [stations, nowSeconds]
  );

  return (
    <StationsContext.Provider value={view}>{children}</StationsContext.Provider>
  );
}

/** What the relay currently announces, kept fresh — the routes' one read. */
export function useStations(): StationsView {
  return useContext(StationsContext);
}
