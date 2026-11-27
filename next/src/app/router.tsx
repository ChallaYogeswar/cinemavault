import { createBrowserRouter, createMemoryRouter, type RouteObject } from 'react-router-dom';
import { RequireSession } from './RequireSession';
import { RouteError } from './RouteError';
import { FullPageStatus } from '@/components/ui/FullPageStatus';
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage';
import { SignInPage } from '@/features/auth/SignInPage';
import { SignUpPage } from '@/features/auth/SignUpPage';
import { AppShell } from '@/components/layout/AppShell';
import { HomePage } from '@/features/home/HomePage';
import { SectionPlaceholder } from '@/features/home/SectionPlaceholder';
import { LibraryPage } from '@/features/library/LibraryPage';
import { MovieDetailDialog } from '@/features/library/MovieDetailDialog';

/**
 * Screens other than Home and the library are loaded when first opened, so the first visit
 * downloads less. They are all in the service worker's precache, so they still open offline.
 */
const loadDiscover = () =>
  import('@/features/discover/DiscoverPage').then((m) => ({ Component: m.DiscoverPage }));
const loadGenres = () =>
  import('@/features/genres/GenresPage').then((m) => ({ Component: m.GenresPage }));
const loadStats = () =>
  import('@/features/statistics/StatsPage').then((m) => ({ Component: m.StatsPage }));
const loadSettings = () =>
  import('@/features/settings/SettingsPage').then((m) => ({ Component: m.SettingsPage }));
const loadAddMovie = () =>
  import('@/features/library/AddMovieDialog').then((m) => ({ Component: m.AddMovieDialog }));
const loadEditMovie = () =>
  import('@/features/library/EditMovieDialog').then((m) => ({ Component: m.EditMovieDialog }));

/**
 * Everything inside the signed-in shell. Tests that supply their own session mount just this.
 * The error screen sits INSIDE the shell, so a failing screen still leaves the navigation usable.
 */
export const appRoutes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      {
        errorElement: <RouteError />,
        children: [
          { index: true, element: <HomePage /> },
          {
            path: 'library',
            element: <LibraryPage />,
            // Dialogs are routes so they deep-link and the back button closes them.
            children: [
              { path: 'new', lazy: loadAddMovie },
              { path: ':id', element: <MovieDetailDialog /> },
              { path: ':id/edit', lazy: loadEditMovie },
            ],
          },
          { path: 'genres', lazy: loadGenres },
          { path: 'discover', lazy: loadDiscover },
          { path: 'stats', lazy: loadStats },
          { path: 'settings', lazy: loadSettings },
          {
            path: '*',
            element: (
              <SectionPlaceholder
                eyebrow="404"
                title="That page isn’t in the vault."
                milestone="—"
              />
            ),
          },
        ],
      },
    ],
  },
];

/** The full application: public auth screens, and the shell behind `RequireSession`. */
export const routes: RouteObject[] = [
  { path: 'sign-in', element: <SignInPage /> },
  { path: 'sign-up', element: <SignUpPage /> },
  { path: 'forgot-password', element: <ForgotPasswordPage /> },
  { path: 'reset-password', element: <ResetPasswordPage /> },
  {
    element: <RequireSession />,
    errorElement: <RouteError />,
    HydrateFallback: () => <FullPageStatus label="Loading…" />,
    children: appRoutes,
  },
];

export const createAppRouter = () => createBrowserRouter(routes);

const memory = (tree: RouteObject[], initialEntries: string[], initialIndex?: number) =>
  createMemoryRouter(tree, {
    initialEntries,
    ...(initialIndex === undefined ? {} : { initialIndex }),
  });

/** The signed-in shell only; the test supplies the session around it. */
export const createTestRouter = (initialEntries: string[], initialIndex?: number) =>
  memory(appRoutes, initialEntries, initialIndex);

/** The whole application including sign-in and the session guard. */
export const createFullTestRouter = (initialEntries: string[], initialIndex?: number) =>
  memory(routes, initialEntries, initialIndex);
