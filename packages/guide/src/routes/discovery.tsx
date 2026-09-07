import { Card, CardContent } from '@/components/ui/card';

/**
 * `/` — the discovery grid. #76 renders it from the hub relay's
 * announcements: one station card per announced station, each leading with
 * the rung ladder and its per-segment prices — the real number this system
 * has — never an audience figure.
 */
export function Discovery() {
  return (
    <section>
      <h1 className="text-2xl font-bold">Discover</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Every station announced to this hub, and what vibing with each one
        costs.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nothing is announced yet. When broadcasters announce their stations,
            cards land here — each leading with its rung ladder and per-segment
            prices.
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
