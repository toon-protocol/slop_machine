import { BrowserRouter, Route, Routes } from 'react-router';
import { Shell } from '@/shell/shell';
import { StationsProvider } from '@/relay/stations-context';
import { Discovery } from '@/routes/discovery';
import { Categories } from '@/routes/categories';
import { Category } from '@/routes/category';
import { BroadcasterPage } from '@/routes/broadcaster-page';

/**
 * The guide's four routes, and only these. No bare vanity URLs: display names
 * are not unique, and the handle is the only identity anybody grants — so a
 * broadcaster page lives at `/b/:handle` and nowhere shorter.
 *
 * Every route sits inside the stations provider: one relay subscription for
 * the whole page, which the grid, the sidebar and (as #77 and #78 land) the
 * category and broadcaster views all read from.
 */
export function App() {
  return (
    <StationsProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/" element={<Discovery />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/categories/:category" element={<Category />} />
            <Route path="/b/:handle" element={<BroadcasterPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </StationsProvider>
  );
}
