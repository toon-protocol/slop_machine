import { useParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

/**
 * `/b/:handle` — the broadcaster page: the free, public description of a
 * station, which a viber reads to decide whether to vibe. Everything on it is
 * free — that is what keeps trying a new broadcaster cheap. #77 fills the
 * profile and clips from the broadcaster's own announcements; #78 lights up
 * live playback where a paying daemon is present.
 *
 * The viber-count slot is reserved and renders empty: no source produces the
 * number yet, and reserving the space now is what lets presence arrive
 * without a redesign.
 */
export function BroadcasterPage() {
  const { handle } = useParams();

  return (
    <article>
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          {/* Avatar from the broadcaster's profile (#77). */}
          <div className="size-16 rounded-full bg-muted" aria-hidden />
          <div>
            <h1 className="text-2xl font-bold">{handle}</h1>
            <p className="text-sm text-muted-foreground">
              Display name and about arrive with the broadcaster&apos;s profile.
            </p>
          </div>
        </div>
        {/* The reserved viber-count slot: empty until presence exists. */}
        <div className="min-w-24 text-right" data-slot="viber-count" />
      </header>

      <div className="mt-4 flex items-center gap-2">
        <Badge variant="secondary">off the air</Badge>
        {/* Category badges from the station's announcement (#77). */}
      </div>

      <Separator className="my-6" />

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <h2 className="text-lg font-semibold">Clips</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Try this broadcaster&apos;s vibes for free before paying to vibe
            live. A clip costs nobody anything to play.
          </p>
          <Card className="mt-4 border-dashed">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No clips yet.
            </CardContent>
          </Card>
        </section>

        <section>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Rung ladder</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              What vibing live costs at each quality, per segment — announced by
              the station itself. The ladder lands with the station&apos;s
              announcement.
            </CardContent>
          </Card>
        </section>
      </div>
    </article>
  );
}
