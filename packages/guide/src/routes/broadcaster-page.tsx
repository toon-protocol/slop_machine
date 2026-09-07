import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { RELAY_URL } from '@/relay/relay-url';
import { subscribeToRelay } from '@/relay/nip01';
import { CLIP_KIND } from '@/relay/announcements';
import {
  absorbClip,
  clipDuration,
  clipsFrom,
  type Clip,
  type ClipLog,
} from '@/relay/clips';
import { useStations } from '@/relay/stations-context';
import { isLive, type Station } from '@/relay/stations';

/**
 * `/b/:handle` — the broadcaster page: the free, public description of a
 * station, which a viber reads to decide whether to vibe. Everything on it
 * is free — that is what keeps trying a new broadcaster cheap.
 *
 * The handle is the route's identity and the station's: the last segment of
 * the address a hub granted, which is exactly what the grid's cards link
 * with. The profile (kind 0), the ladder (the station announcement) and the
 * liveness (the heartbeat) all come off the same provider the grid reads;
 * the clips are this page's own subscription, kind 1063 filtered to the
 * broadcaster's pubkey, and each one plays in-page from a free fetch.
 *
 * The viber-count slot is reserved and renders empty — a visibly held spot
 * with no value, never a fake number — so presence, when it exists, is a
 * value change and not a redesign.
 */
export function BroadcasterPage() {
  const { handle } = useParams();
  const { stations, nowSeconds } = useStations();

  const station = stations.find((candidate) => candidate.handle === handle);

  if (station === undefined) {
    return (
      <article>
        <header className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="size-16 rounded-full bg-muted" aria-hidden />
            <h1 className="text-2xl font-bold">{handle}</h1>
          </div>
          <ViberCountSlot />
        </header>
        <Separator className="my-6" />
        <p className="text-sm text-muted-foreground">
          Nothing is announced for this broadcaster on this hub&apos;s relay.
          When their station is announced, its ladder and clips land here.
        </p>
      </article>
    );
  }

  return <AnnouncedBroadcaster station={station} nowSeconds={nowSeconds} />;
}

function AnnouncedBroadcaster({
  station,
  nowSeconds,
}: {
  station: Station;
  nowSeconds: number;
}) {
  const clips = useClips(station.pubkey);
  const onTheAir = isLive(station, nowSeconds);

  return (
    <article>
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          {station.picture !== null ? (
            <img
              src={station.picture}
              alt=""
              className="size-16 rounded-full bg-muted object-cover"
            />
          ) : (
            <div className="size-16 rounded-full bg-muted" aria-hidden />
          )}
          <div>
            <h1 className="text-2xl font-bold" data-testid="broadcaster-name">
              {station.name ?? station.handle}
            </h1>
            <p
              className="text-sm text-muted-foreground"
              data-testid="broadcaster-about"
            >
              {station.broadcasterAbout ??
                'This broadcaster has not published a profile yet.'}
            </p>
          </div>
        </div>
        <ViberCountSlot />
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {onTheAir ? (
          <Badge variant="destructive" data-testid="live-badge">
            live
          </Badge>
        ) : (
          <Badge variant="secondary">off the air</Badge>
        )}
        {station.categories.map((category) => (
          <Badge
            key={category}
            variant="secondary"
            data-testid="category-badge"
          >
            {category}
          </Badge>
        ))}
      </div>

      <Separator className="my-6" />

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <h2 className="text-lg font-semibold">Clips</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Try this broadcaster&apos;s vibes for free before paying to vibe
            live. A clip costs nobody anything to play.
          </p>
          <ClipList clips={clips} />
        </section>

        <section>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Rung ladder</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {station.rungs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No ladder is announced yet.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {station.rungs.map((rung) => (
                      <tr key={rung.rung} data-testid="rung-row">
                        <td className="py-0.5 font-medium">{rung.rung}</td>
                        <td className="py-0.5 text-right tabular-nums text-muted-foreground">
                          {rung.price}
                          {station.segmentSeconds !== null
                            ? ` / ${String(station.segmentSeconds)}s segment`
                            : ' / segment'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="text-sm text-muted-foreground">
                What vibing live costs at each quality, per segment — announced
                by the station itself.
              </p>
              {station.about !== '' && (
                <p className="text-sm text-muted-foreground">{station.about}</p>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </article>
  );
}

/**
 * The reserved viber-count slot: present in the layout, absent in value. No
 * source produces the number yet, and an empty labelled spot is honest where
 * a made-up figure would not be.
 */
function ViberCountSlot() {
  return (
    <div
      className="min-w-24 rounded-lg border border-dashed px-3 py-2 text-right"
      data-slot="viber-count"
    >
      <div className="text-xs tracking-wide text-muted-foreground uppercase">
        vibers
      </div>
      <div
        className="min-h-6 text-lg font-semibold"
        data-testid="viber-count-value"
      />
    </div>
  );
}

/** The clip list, newest first, each playable in-page from a free fetch. */
function ClipList({ clips }: { clips: Clip[] }) {
  const [playing, setPlaying] = useState<Clip | null>(null);
  const playerRef = useRef<HTMLVideoElement>(null);

  // Play on selection. A refusal (an autoplay policy, a URL nothing answers)
  // leaves the controls in the viber's hands rather than an error on screen.
  useEffect(() => {
    if (playing !== null) {
      void playerRef.current?.play().catch(() => undefined);
    }
  }, [playing]);

  if (clips.length === 0) {
    return (
      <Card className="mt-4 border-dashed">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No clips yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mt-4">
      {playing !== null && (
        <figure className="mb-4">
          <video
            key={playing.id}
            ref={playerRef}
            data-testid="clip-player"
            src={playing.url}
            controls
            playsInline
            className="w-full rounded-lg border bg-black"
          />
          <figcaption className="mt-2 text-sm text-muted-foreground">
            {playing.title ?? 'a clip'}
            {playing.description !== '' && ` — ${playing.description}`}
          </figcaption>
        </figure>
      )}
      <ul className="flex flex-col gap-2">
        {clips.map((clip) => (
          <li key={clip.id}>
            <button
              type="button"
              data-testid="clip-row"
              onClick={() => {
                setPlaying(clip);
              }}
              className="flex w-full items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-left text-sm transition-colors hover:border-primary/50"
            >
              <span className="truncate font-medium">
                {clip.title ?? 'a clip'}
              </span>
              {clip.durationSeconds !== null && (
                <span
                  className="text-muted-foreground shrink-0 tabular-nums"
                  data-testid="clip-duration"
                >
                  {clipDuration(clip.durationSeconds)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One broadcaster's clips, kept fresh: a kind 1063 subscription filtered to
 * that pubkey, absorbed one event per clip and derived newest first. The
 * relay was asked for one author; the check inside holds it to its answer.
 */
function useClips(pubkey: string): Clip[] {
  const log = useRef<ClipLog>(new Map());
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    log.current = new Map();
    setRevision((standing) => standing + 1);
    const subscription = subscribeToRelay(
      RELAY_URL,
      [CLIP_KIND],
      (event) => {
        if (event.pubkey !== pubkey) return;
        if (absorbClip(log.current, event)) {
          setRevision((standing) => standing + 1);
        }
      },
      [pubkey]
    );
    return () => {
      subscription.close();
    };
  }, [pubkey]);

  // The log is a mutable ref; the revision is what says it changed.
  return useMemo(() => clipsFrom(log.current), [revision]);
}
