/**
 * From the station list to the categories a viber browses by — pure
 * derivation, no socket and no clock of its own, the same shape as
 * `stations.ts` beside it.
 *
 * A category exists because a station announced itself under it, and for no
 * other reason. ADR 0004 makes the `t` tags free-form on purpose — a
 * broadcaster describes their own vibes rather than fitting a list somebody
 * else curated — so this derivation is the whole story of which categories
 * there are. The guide is never a categories authority: curation lives with
 * the route that renders the tiles, and decides prominence only, never
 * existence.
 */

import { isLive, type Station } from '@/relay/stations';

/** One announced category, everything a tile renders. */
export interface CategoryView {
  /** The label, exactly as a broadcaster announced it. */
  name: string;
  /** How many stations are announced under it. */
  stationCount: number;
  /** How many of those hold an unexpired heartbeat right now. */
  liveCount: number;
}

/**
 * Every category any station in the list announces itself under,
 * alphabetically. A station announcing one category twice counts once; a
 * station announcing several categories counts under each. Liveness is
 * evaluated against the caller's clock, exactly as `isLive` demands.
 */
export function categoriesFrom(
  stations: Station[],
  nowSeconds: number
): CategoryView[] {
  const views = new Map<string, CategoryView>();

  for (const station of stations) {
    const live = isLive(station, nowSeconds);
    for (const name of new Set(station.categories)) {
      const view = views.get(name) ?? { name, stationCount: 0, liveCount: 0 };
      view.stationCount += 1;
      if (live) view.liveCount += 1;
      views.set(name, view);
    }
  }

  return [...views.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}
