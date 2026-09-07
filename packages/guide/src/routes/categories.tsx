import { Card, CardContent } from '@/components/ui/card';

/**
 * `/categories` — every category any station announces itself under, as
 * tiles. Categories are free-form labels a broadcaster picks; the guide
 * groups what it reads, it curates nothing. #76 renders the tiles from the
 * announcements.
 */
export function Categories() {
  return (
    <section>
      <h1 className="text-2xl font-bold">Categories</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Browse by what kind of vibes you are in the mood for, rather than by
        broadcaster name.
      </p>
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No categories yet. A category exists the moment a station announces
            itself under one.
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
