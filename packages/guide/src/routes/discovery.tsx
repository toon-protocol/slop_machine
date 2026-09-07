import { Card, CardContent } from '@/components/ui/card';
import { useStations } from '@/relay/stations-context';
import { StationCard } from '@/routes/station-card';

/**
 * `/` — the discovery grid, rendered from the hub relay's announcements: one
 * station card per announced station, each leading with the rung ladder and
 * its per-segment prices — the real number this system has — never an
 * audience figure. Stations arrive deduplicated first-mover-wins per
 * address, so a squatter announcing somebody else's station cannot shadow
 * the original here.
 */
export function Discovery() {
  const { stations, nowSeconds } = useStations();

  return (
    <section>
      <h1 className="text-2xl font-bold">Discover</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Every station announced to this hub, and what vibing with each one
        costs.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {stations.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              Nothing is announced yet. When broadcasters announce their
              stations, cards land here — each leading with its rung ladder and
              per-segment prices.
            </CardContent>
          </Card>
        ) : (
          stations.map((station) => (
            <StationCard
              key={station.address}
              station={station}
              nowSeconds={nowSeconds}
            />
          ))
        )}
      </div>
    </section>
  );
}
