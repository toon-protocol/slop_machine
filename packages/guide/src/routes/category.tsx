import { useParams, Link } from 'react-router';
import { Card, CardContent } from '@/components/ui/card';
import { useStations } from '@/relay/stations-context';
import { StationCard } from '@/routes/station-card';

/**
 * `/categories/:category` — every station announced under one category, as
 * the same station cards the discovery grid uses: ladder and per-segment
 * prices leading, the live badge exactly while an unexpired heartbeat
 * exists. A station announcing several categories appears under each; a
 * category nobody announced renders the honest empty state rather than a
 * page that pretends the label was ever a thing.
 */
export function Category() {
  const { category } = useParams();
  const { stations, nowSeconds } = useStations();

  const announced =
    category === undefined
      ? []
      : stations.filter((station) => station.categories.includes(category));

  return (
    <section>
      <p className="text-sm text-muted-foreground">
        <Link to="/categories" className="hover:text-foreground">
          Categories
        </Link>{' '}
        / {category}
      </p>
      <h1 className="mt-1 text-2xl font-bold">{category}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Stations announced under this category.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {announced.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No station is announced under this category yet.
            </CardContent>
          </Card>
        ) : (
          announced.map((station) => (
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
