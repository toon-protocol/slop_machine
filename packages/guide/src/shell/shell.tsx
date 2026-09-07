import { Link, NavLink, Outlet } from 'react-router';
import { Radio } from 'lucide-react';

/**
 * The dark shell every route renders inside: a top bar, a left sidebar that
 * will hold the live stations, and the main surface. The layout is the
 * familiar one on purpose — a viber should know where everything is before
 * they have read a word — but the words are this domain's own: stations, not
 * streams; vibing, not viewing.
 */
export function Shell() {
  return (
    <div className="flex min-h-screen flex-col">
      <TopBar />
      <div className="flex flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function TopBar() {
  const navLink = ({ isActive }: { isActive: boolean }) =>
    isActive
      ? 'text-sm font-semibold text-primary'
      : 'text-sm font-semibold text-muted-foreground hover:text-foreground';

  return (
    <header className="sticky top-0 z-10 flex h-12 items-center gap-6 border-b bg-card px-4">
      <Link to="/" className="flex items-center gap-2 font-bold">
        <Radio className="size-5 text-primary" aria-hidden />
        the guide
      </Link>
      <nav className="flex items-center gap-4">
        <NavLink to="/" end className={navLink}>
          Discover
        </NavLink>
        <NavLink to="/categories" className={navLink}>
          Categories
        </NavLink>
      </nav>
    </header>
  );
}

function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 border-r bg-card/50 p-4 md:block">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Live stations
      </h2>
      {/* #76 fills this from the hub relay's announcements: every station
          with an unexpired heartbeat, its handle linking to /b/:handle. */}
      <p className="mt-3 text-sm text-muted-foreground">
        No stations are on the air yet. Live stations land here as broadcasters
        announce them.
      </p>
    </aside>
  );
}
