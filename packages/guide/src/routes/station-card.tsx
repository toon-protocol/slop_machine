/**
 * One station, one card — the unit of the discovery grid, and (as #77 lands)
 * of the category views too.
 *
 * The ladder LEADS. Per-segment prices are the real number this system has —
 * derived by the broadcaster from their own connector's published routes,
 * never an audience figure — so choosing a station is choosing a price a
 * viber can see before they commit. The live badge appears exactly while an
 * unexpired heartbeat exists, which the provider re-evaluates on a clock, so
 * a lapsing heartbeat drops it with no reload.
 */

import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { isLive, type Station } from '@/relay/stations';

export function StationCard({
  station,
  nowSeconds,
}: {
  station: Station;
  nowSeconds: number;
}) {
  const onTheAir = isLive(station, nowSeconds);

  return (
    <Link
      to={`/b/${station.handle}`}
      data-testid="station-card"
      className="block rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Card className="h-full gap-4 transition-colors hover:border-primary/50">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <span className="truncate">{station.name ?? station.handle}</span>
            {onTheAir && (
              <Badge variant="destructive" data-testid="live-badge">
                live
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
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
          {station.categories.length > 0 && (
            <div className="flex flex-wrap gap-1">
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
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
