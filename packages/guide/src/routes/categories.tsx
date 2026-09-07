import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useStations } from '@/relay/stations-context';
import { categoriesFrom, type CategoryView } from '@/relay/categories';

/**
 * The categories the guide FEATURES, in the order they lead the page.
 *
 * Curation decides prominence, never existence: a name on this list gets its
 * tile rendered first and marked as featured **if any station announces it**,
 * and creates no tile at all when nobody does — the guide is never a
 * categories authority, and a tile for a category with no stations behind it
 * would be the guide inventing one. Every announced category gets a tile
 * whether it is on this list or not.
 */
const FEATURED_CATEGORIES = ['slop', 'music'];

/**
 * `/categories` — a tile per announced category, derived from the `t` tags
 * of the same deduplicated station set the discovery grid reads. Featured
 * categories lead, larger and marked; the rest follow alphabetically. A
 * category describes the vibes, not the medium — there is deliberately no
 * audio-versus-video split here, because that is a rung's business.
 */
export function Categories() {
  const { stations, nowSeconds } = useStations();
  const categories = categoriesFrom(stations, nowSeconds);

  // Prominence is the featured list's order; existence is the derivation's.
  const featured = FEATURED_CATEGORIES.flatMap((name) => {
    const announced = categories.find((category) => category.name === name);
    return announced === undefined ? [] : [announced];
  });
  const rest = categories.filter(
    (category) => !FEATURED_CATEGORIES.includes(category.name)
  );

  return (
    <section>
      <h1 className="text-2xl font-bold">Categories</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Browse by what kind of vibes you are in the mood for, rather than by
        broadcaster name.
      </p>
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {categories.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No categories yet. A category exists the moment a station
              announces itself under one.
            </CardContent>
          </Card>
        ) : (
          <>
            {featured.map((category) => (
              <CategoryTile key={category.name} category={category} featured />
            ))}
            {rest.map((category) => (
              <CategoryTile key={category.name} category={category} />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function CategoryTile({
  category,
  featured = false,
}: {
  category: CategoryView;
  featured?: boolean;
}) {
  return (
    <Link
      to={`/categories/${encodeURIComponent(category.name)}`}
      data-testid="category-tile"
      className={
        'block rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none' +
        (featured ? ' col-span-2' : '')
      }
    >
      <Card className="h-full gap-3 transition-colors hover:border-primary/50">
        <CardHeader>
          <CardTitle
            className={
              'flex items-center justify-between gap-2' +
              (featured ? ' text-xl' : '')
            }
          >
            <span className="truncate">{category.name}</span>
            {featured && (
              <Badge variant="secondary" data-testid="featured-badge">
                featured
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {category.stationCount === 1
            ? '1 station'
            : `${String(category.stationCount)} stations`}
          {category.liveCount > 0 && (
            <span className="text-destructive">
              {' · '}
              {String(category.liveCount)} live
            </span>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
