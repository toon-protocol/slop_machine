/**
 * Vibing live — the theater on the broadcaster page, lit by detection.
 *
 * With a paying side detected on loopback (the playback contract, ADR 0005),
 * a viber clicks and vibing starts in-page: the guide initiates it across
 * the contract and plays the playlist the state names for the selected rung.
 * Rungs switch mid-broadcast from here, every choice within the budget the
 * paying side owns — the guide never sends a budget anywhere, and every
 * number on screen (the spend, the broadcaster/hub split, each rung's price)
 * is the state's own decimal string rendered verbatim, computed nowhere in
 * the guide.
 *
 * With no paying side detected, the same affordance renders an explanation
 * of how to vibe — an explanation, not an error and not a broken player:
 * hosted, this page can render anything and pay for nothing, by design.
 *
 * The media path is the one the devnet's own demo page proves in Chromium:
 * hls.js over the synthesized live playlist, held close to the live edge,
 * with the native `src` fallback where HLS is built in. hls.js is an
 * ordinary guide dependency — a playlist parser is no more payment code than
 * a router is; the money never leaves the paying side of the line.
 */

import { useEffect, useRef } from 'react';
import Hls from 'hls.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { usePlayback } from '@/playback/playback-context';
import type { PlaybackState, PlaybackRung } from '@/playback/playback';
import type { Station } from '@/relay/stations';

export function VibeLive({ station }: { station: Station }) {
  const { state, vibe, stop, selectRung } = usePlayback();

  // Hosted, honestly: no paying side answered on loopback. The affordance
  // degrades into how-to-vibe, never into an error.
  if (state === null) {
    return (
      <Card className="mt-6 border-dashed" data-testid="hosted-explanation">
        <CardHeader>
          <CardTitle className="text-lg">Vibe live</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            Vibing live needs a paying side, and this page can render anything
            and pay for nothing. Run the guide on your own machine beside a
            paying daemon on loopback and this affordance lights up — the daemon
            owns your budget, buys each segment as it plays, and this page
            becomes the player. The devnet demo serves one:{' '}
            <code className="text-foreground">pnpm demo --pattern</code>.
          </p>
        </CardContent>
      </Card>
    );
  }

  // A paying side pays the stations it is set up for, and this is not one of
  // them. Said plainly rather than left as a button that would be refused.
  if (state.station !== station.address) {
    return (
      <Card className="mt-6 border-dashed" data-testid="unpayable-station">
        <CardHeader>
          <CardTitle className="text-lg">Vibe live</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            Your paying side is set up to pay a different station. It vibes only
            with stations it can pay; this broadcaster is not among them yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Theater state={state} vibe={vibe} stop={stop} selectRung={selectRung} />
  );
}

function Theater({
  state,
  vibe,
  stop,
  selectRung,
}: {
  state: PlaybackState;
  vibe: (station: string) => void;
  stop: () => void;
  selectRung: (rung: string) => void;
}) {
  // Vibing with no rung selected yet: choose the dearest, through the
  // contract like any deliberate choice would be — a theater should open on
  // the best picture the ladder offers, and the viber drops from there.
  const dearest = state.rungs.at(-1)?.rung;
  useEffect(() => {
    if (state.vibing && state.rung === null && dearest !== undefined) {
      selectRung(dearest);
    }
  }, [state.vibing, state.rung, dearest, selectRung]);

  const playing = state.rungs.find((rung) => rung.rung === state.rung);

  return (
    <section className="mt-6" data-testid="theater">
      <div className="overflow-hidden rounded-xl border bg-black">
        {state.vibing ? (
          <LivePlayer playlist={playing?.playlist ?? null} />
        ) : (
          <div className="flex aspect-video flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              {state.live
                ? 'This station is on the air. Vibing buys each segment as it plays, within the budget your paying side owns.'
                : 'This station is off the air right now. Vibing starts the moment it is back.'}
            </p>
            <Button
              size="lg"
              data-testid="vibe-live-button"
              onClick={() => {
                vibe(state.station);
              }}
            >
              Vibe live
            </Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2 border-t bg-card p-3">
          {state.rungs.map((rung) => (
            <RungButton
              key={rung.rung}
              rung={rung}
              selected={rung.rung === state.rung}
              selectRung={selectRung}
            />
          ))}
          {state.vibing && (
            <Button
              variant="secondary"
              className="ml-auto"
              data-testid="stop-vibing-button"
              onClick={stop}
            >
              Stop vibing
            </Button>
          )}
        </div>
      </div>

      <SpendPanel state={state} />
    </section>
  );
}

/**
 * The picture, from the playlist the contract's state names. The paying side
 * writes that playlist out of segments it already bought — this element only
 * ever plays what is already paid for.
 */
function LivePlayer({ playlist }: { playlist: string | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const attachedRef = useRef<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null || playlist === null) return;
    if (attachedRef.current === playlist) return;
    attachedRef.current = playlist;

    hlsRef.current?.destroy();
    hlsRef.current = null;

    if (Hls.isSupported()) {
      // A live window only ever a few segments deep: hold close to its edge,
      // and jump rather than stall when the window slides past us — the same
      // numbers the devnet's demo page proves.
      const hls = new Hls({
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 6,
      });
      hlsRef.current = hls;
      hls.loadSource(playlist);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR)
          hls.recoverMediaError();
      });
    } else {
      // Anything that plays HLS natively.
      video.src = playlist;
    }
    void video.play().catch(() => undefined);
    // An autoplay policy may refuse; the controls are there.
  }, [playlist]);

  useEffect(
    () => () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    },
    []
  );

  return (
    <video
      ref={videoRef}
      data-testid="live-player"
      controls
      autoPlay
      muted
      playsInline
      className="aspect-video w-full bg-black"
    />
  );
}

/**
 * One rung, one price, one split — the state's own decimal strings, verbatim.
 * Clicking is a POST at the paying side, never only a local secret: the rung
 * a viber vibes at is the contract's fact.
 */
function RungButton({
  rung,
  selected,
  selectRung,
}: {
  rung: PlaybackRung;
  selected: boolean;
  selectRung: (rung: string) => void;
}) {
  return (
    <button
      type="button"
      data-testid="vibe-rung"
      aria-pressed={selected}
      onClick={() => {
        selectRung(rung.rung);
      }}
      className={`flex-1 basis-32 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
        selected
          ? 'border-primary bg-primary/10'
          : 'bg-background hover:border-primary/50'
      }`}
    >
      <div className="font-semibold">{rung.rung}</div>
      <div className="tabular-nums text-muted-foreground">
        {rung.price} / segment
      </div>
      <div className="text-xs tabular-nums text-muted-foreground">
        {rung.toStation} broadcaster · {rung.toHub} hub
      </div>
    </button>
  );
}

/**
 * The spend and the split, rendered and never computed: `spent`, `toStation`
 * and `toHub` are the paying side's own ledger — the pulls that find the
 * live edge included, which is exactly why the guide must not multiply them
 * out of per-rung counts.
 */
function SpendPanel({ state }: { state: PlaybackState }) {
  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Spent vibing</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <div
            className="text-2xl font-semibold tabular-nums"
            data-testid="vibe-spent"
          >
            {state.spent}
          </div>
          <p className="mt-1 text-muted-foreground">
            base units, across{' '}
            <span data-testid="vibe-packets">{state.packets}</span> paid packets
            {state.vibing ? (
              <Badge variant="destructive" className="ml-2">
                vibing
              </Badge>
            ) : (
              <Badge variant="secondary" className="ml-2">
                not vibing
              </Badge>
            )}
          </p>
          <p className="mt-2 text-muted-foreground">
            Your paying side's budget:{' '}
            <span className="tabular-nums" data-testid="vibe-budget">
              {state.budgetPerSecond}
            </span>{' '}
            per second — its own figure, which nothing on this page can raise.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Where the money went</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <div className="flex justify-between py-1">
            <span>to the broadcaster</span>
            <span className="tabular-nums" data-testid="vibe-to-station">
              {state.toStation}
            </span>
          </div>
          <div className="flex justify-between py-1">
            <span>to the hub, for carriage</span>
            <span className="tabular-nums" data-testid="vibe-to-hub">
              {state.toHub}
            </span>
          </div>
          <p className="mt-2 text-muted-foreground">
            Split at the two nodes' own published prices, reported by the paying
            side — the guide computes nothing about money on its own.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
