import { Link, NavLink, Outlet } from 'react-router-dom';
import { useSession } from '@/app/session';
import { NAV_ITEMS } from '@/components/navigation/navItems';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'whitespace-nowrap rounded-full px-1 py-2 text-center text-[13px] sm:px-3.5 transition-colors duration-300',
    isActive ? 'text-text' : 'text-muted hover:text-text',
  ].join(' ');

/**
 * Responsive shell: a floating glass top bar on desktop; on narrow screens the brand and the
 * settings button stay on one row and the five sections share a second row equally (they all fit
 * at 320 px; with very large text the row scrolls instead of clipping).
 * The page area is keyed by the signed-in account, so another account never inherits an open
 * dialog, a half-typed form or a pending-request indicator from the previous one.
 */
export function AppShell() {
  const { userId } = useSession();
  return (
    <div className="min-h-screen">
      <a
        href="#main-content"
        // Move focus without adding a "#main-content" history entry: that entry made the Back
        // button (and so closing a title dialog) drop keyboard focus to the page.
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-text focus:px-4 focus:py-2 focus:text-bg"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 px-3 pt-3 sm:px-6 sm:pt-4">
        <div className="border-line mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-3xl border bg-surface/70 px-3 py-2 backdrop-blur-xl sm:flex-nowrap sm:rounded-full sm:px-4">
          <Link to="/" className="flex items-center gap-2.5 font-extrabold tracking-tight">
            <span
              aria-hidden="true"
              className="bg-text text-bg grid size-9 place-items-center rounded-full font-mono text-[11px] font-bold tracking-[0.08em]"
            >
              CV
            </span>
            <span className="text-[15px]">CinemaVault</span>
          </Link>

          <nav
            aria-label="Primary"
            className="order-3 grid w-full grid-cols-[repeat(5,minmax(max-content,1fr))] overflow-x-auto sm:order-none sm:flex sm:w-auto sm:gap-1 sm:overflow-visible"
          >
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className={linkClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <NavLink
            to="/settings"
            aria-label="Settings"
            className="border-line text-muted hover:text-text grid size-10 place-items-center rounded-full border text-sm transition-colors"
          >
            ⚙
          </NavLink>
        </div>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="outline-none mx-auto max-w-6xl px-4 pb-24 pt-14 sm:px-6 sm:pt-20"
      >
        <Outlet key={userId} />
      </main>
    </div>
  );
}
