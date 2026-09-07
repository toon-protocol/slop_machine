import { BrowserRouter, Route, Routes } from 'react-router';
import { Shell } from '@/shell/shell';
import { StationsProvider } from '@/relay/stations-context';
import { PlaybackProvider } from '@/playback/playback-context';
import { Discovery } from '@/routes/discovery';
import { Categories } from '@/routes/categories';
import { Category } from '@/routes/category';
import { BroadcasterPage } from '@/routes/broadcaster-page';

/**
 * The guide's four routes, and only these. No bare vanity URLs: display names
 * are not unique, and the handle is the only identity anybody grants — so a
 * broadcaster page lives at `/b/:handle` and nowhere shorter.
 *
 * Every route sits inside two providers: the stations provider — one relay
 * subscription for the whole page, which the grid, the sidebar and the
 * category and broadcaster views all read from — and the playback provider,
 * one poll of the loopback playback contract, which is what makes the guide
 * hybrid by detection: a paying side answering lights up vibing live, and
 * none answering is the hosted mode.
 */
export function App() {
  return (
    <StationsProvider>
      <PlaybackProvider>
        {/*
          `basename` follows the build's own `base`, so the SAME routes work
          at a domain root ('/' — a hub's own hosting, the dev server, the
          e2e harness) and under a subpath (a static host like GitHub Pages
          serves a project at /<repo>/). Vite guarantees BASE_URL ends the
          way a basename must, and at the default base this is exactly the
          '/' it has always been.
        */}
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="/" element={<Discovery />} />
              <Route path="/categories" element={<Categories />} />
              <Route path="/categories/:category" element={<Category />} />
              <Route path="/b/:handle" element={<BroadcasterPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </PlaybackProvider>
    </StationsProvider>
  );
}
