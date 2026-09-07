import { useParams, Link } from 'react-router';
import { Card, CardContent } from '@/components/ui/card';

/**
 * `/categories/:category` — every station announced under one category, as
 * the same station cards the discovery grid uses. #76 fills it from the
 * announcements.
 */
export function Category() {
  const { category } = useParams();

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
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No station is announced under this category yet.
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
