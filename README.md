# CinemaVault

**Your personal movie and TV library — organized, discoverable, and available across devices.**

CinemaVault is a web application for managing a personal collection of movies and TV shows. It brings together library management, ratings and watch status, title discovery, movie metadata and posters, personalized recommendations, account-based access, and an offline-friendly experience.

> **Project status:** The repository currently contains the original application at the repository root and a newer TypeScript/React application in `next/`. The newer application is developed in parallel; production cutover is not yet complete. Review [`docs/release-checklist.md`](docs/release-checklist.md) before deploying or switching production traffic.

---

## Contents

- [Highlights](#highlights)
- [Technology](#technology)
- [Architecture](#architecture)
- [Repository structure](#repository-structure)
- [Getting started](#getting-started)
- [Environment configuration](#environment-configuration)
- [Database and security](#database-and-security)
- [Offline and PWA behaviour](#offline-and-pwa-behaviour)
- [Testing and quality checks](#testing-and-quality-checks)
- [Deployment notes](#deployment-notes)
- [Documentation](#documentation)
- [Acknowledgements](#acknowledgements)

## Highlights

### Personal library

- Maintain a collection of movies and TV titles.
- Add, view, edit, rate, and remove library entries.
- Track viewing information and organize titles using available metadata and filters.
- Detect duplicate titles using a normalized title identity.

### Discover and recommendations

- Explore titles and genres beyond the saved library.
- Get recommendations using a dedicated recommendation engine.
- Keep recommendation history scoped to the signed-in account.
- Retrieve title metadata, posters, and related information through **The Movie Database (TMDB)** integration.

### Accounts and sharing

- Supabase Authentication provides account sign-in.
- Owner and viewer roles support controlled library sharing.
- Database Row Level Security (RLS) enforces access rules; frontend role checks are not treated as a security boundary.
- Account-specific data and local caches are isolated between users.

### Offline-friendly experience

- The newer application stores a validated copy of the signed-in user's library locally using IndexedDB.
- Previously loaded library data can be viewed when the network is unavailable.
- Creating, editing, and deleting entries require a connection.
- The installable PWA shell can load offline after it has been cached.

## Technology

| Area                       | Technologies                                      |
| -------------------------- | ------------------------------------------------- |
| Frontend (new application) | React 19, TypeScript, Vite                        |
| Styling                    | Tailwind CSS v4                                   |
| Routing and data state     | React Router, TanStack Query                      |
| Forms and validation       | React Hook Form, Zod                              |
| Backend services           | Supabase Auth, PostgreSQL, PostgREST              |
| Local persistence          | IndexedDB, Dexie                                  |
| Movie metadata             | TMDB API through a server-side Vercel function    |
| Testing                    | Vitest, React Testing Library, PGlite, Playwright |
| Hosting configuration      | Vercel                                            |

The original root-level application is maintained separately from the newer `next/` application.

## Architecture

The repository is in a parallel-application phase:

```text
Repository
├── Original application (repository root)
│   ├── Existing frontend and services
│   └── Existing API routes
│
├── New application (next/)
│   ├── React + TypeScript UI
│   ├── Domain and repository layers
│   ├── Supabase-backed data access
│   ├── Per-account IndexedDB cache
│   ├── PWA support
│   └── TMDB serverless proxy
│
└── Shared backend assets
    ├── supabase/migrations/
    ├── supabase/tests/
    └── docs/
```

The newer application's main design principles include:

- **Repository-based data access:** UI features depend on repository contracts rather than directly coupling screens to the backend.
- **Server-enforced authorization:** PostgreSQL RLS is the security authority.
- **Account isolation:** private queries and local databases are scoped to the authenticated user.
- **Safe concurrent updates:** writes use version checks to prevent silent overwrites.
- **Soft deletion:** deletion state can propagate across devices.
- **Validated local data:** cached data is checked before it is used.
- **Secrets stay server-side:** TMDB credentials are never exposed through Vite client environment variables.

For a deeper explanation, see [`docs/architecture.md`](docs/architecture.md) and [`docs/threat-model.md`](docs/threat-model.md).

## Repository structure

```text
.
├── index.html, app.js, *.css       # Original application
├── api/                            # Original application's API routes
├── src/                             # Shared/original application modules
├── supabase/
│   ├── migrations/                  # Canonical database migration history
│   ├── tests/                       # Database and RLS tests
│   └── ...                          # Seed, validation and setup files
├── next/                            # New React + TypeScript application
│   ├── src/
│   │   ├── app/                     # Providers, routing and session handling
│   │   ├── components/              # Shared UI components
│   │   ├── data/                    # Repository and persistence layers
│   │   ├── domain/                  # Domain models and validation
│   │   ├── features/                # Application screens and features
│   │   ├── pwa/                     # PWA and service-worker integration
│   │   └── services/                # Auth and external service adapters
│   ├── api/                         # Vercel serverless API functions
│   ├── public/                      # Static assets and PWA icons
│   ├── scripts/                     # Validation and migration tooling
│   └── tests/                       # Unit, integration and browser tests
├── docs/                            # Architecture, migration and release docs
└── .github/workflows/               # CI workflows
```

## Getting started

### Prerequisites

For the newer application:

- Node.js **20.19 or later**
- npm
- A Supabase development project (optional when using the local mock backend)
- A TMDB API credential for live movie metadata and posters

### Run the newer application

```bash
cd next
npm ci
```

Create a local environment file:

```bash
cp .env.example .env.local
```

Add your **development** Supabase project values to `.env.local`, then start the development server:

```bash
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`).

#### Run with mock data

The development server can use an in-memory mock backend when no Supabase variables are configured. You can also explicitly select it:

```env
VITE_DATA_SOURCE=mock
VITE_APP_ENV=development
```

Mock mode is intended for development and testing. It is refused in a production environment.

### Run the original application

The original application remains at the repository root and can be served independently. For example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

The original application does not use the `next/` build process. Keep the two applications' setup and deployment configurations separate.

## Environment configuration

The newer application reads client-side configuration from `next/.env.local`. Start with [`next/.env.example`](next/.env.example).

| Variable                        | Purpose                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `VITE_SUPABASE_URL`             | Supabase project URL                                               |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable/anon key                                      |
| `VITE_APP_ENV`                  | Application environment: `development`, `preview`, or `production` |
| `VITE_DATA_SOURCE`              | Optional data source override; `mock` selects the mock backend     |

### TMDB server configuration

Configure these as **server-side environment variables** in the Vercel project that deploys `next/`:

| Variable                   | Purpose                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `TMDB_API_KEY`             | TMDB API key or read-access token; the legacy server-side name `TMDB` is also accepted |
| `SUPABASE_URL`             | Supabase project URL used by the serverless proxy                                      |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key used by the proxy to validate requests                                 |

Use `TMDB_API_KEY` for new deployments; `TMDB` is accepted for existing projects. Do **not** add either name, service-role keys, or other private credentials to variables prefixed with `VITE_`. Vite exposes `VITE_` values to the browser bundle. Never commit real credentials; `.env*` files are ignored apart from the example file.

## Database and security

Supabase is used for authentication and cloud persistence in the newer application. The canonical migration history is maintained in [`supabase/migrations/`](supabase/migrations/); the `next/` application does not maintain a separate migration history.

Important safeguards include:

- PostgreSQL Row Level Security policies for owner, viewer, and unauthenticated access.
- Fail-closed role resolution: missing or invalid role information does not grant write access.
- Per-user query and IndexedDB cache isolation.
- Version-checked updates to detect stale edits.
- Soft-delete propagation.
- Server-side validation of TMDB requests and protected API credentials.

**Important:** Use a development or preview Supabase project for local development and migration rehearsals. Do not point the application at production data unless the documented release gates have been completed and the deployment has been explicitly approved.

See [`supabase/README.md`](supabase/README.md), [`supabase/AUTH_SETUP.md`](supabase/AUTH_SETUP.md), and [`docs/migration-plan.md`](docs/migration-plan.md).

## Offline and PWA behaviour

In the newer application, the last successfully loaded library is stored locally per account. When offline, the application can display that saved library with an offline indicator. Library mutations remain online-only.

The production build includes service-worker support for caching the application shell. This does not mean all remote data or every feature is available offline. Signing out or changing accounts clears the previous account's private cached data.

To build and preview the production version locally:

```bash
cd next
npm run build
npm run preview
```

Install Chromium for the browser test suite if it is not already available:

```bash
npx playwright install chromium
npm run e2e
```

## Testing and quality checks

Run these commands from `next/`:

| Command                | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `npm run typecheck`    | TypeScript checks                                                  |
| `npm run lint`         | ESLint                                                             |
| `npm run format:check` | Prettier formatting validation                                     |
| `npm test`             | Unit, component, integration, database-contract and security tests |
| `npm run build`        | Production build                                                   |
| `npm run check:bundle` | Checks the built output for prohibited credentials                 |
| `npm run e2e`          | Browser-level offline/PWA tests                                    |
| `npm run check`        | Runs typecheck, lint, formatting and tests                         |

Before a release, also follow the manual checks in [`docs/release-checklist.md`](docs/release-checklist.md). Automated tests do not replace real-device, real-account, preview-environment, or production-readiness checks.

## Deployment notes

The original application and the newer application must be deployed as separate Vercel projects while the parallel-app arrangement remains in place.

For the newer application:

1. Create or configure a Vercel project for this repository.
2. Set **Root Directory** to `next`.
3. Add the required client-side Supabase variables and server-side TMDB/proxy variables.
4. Deploy to a preview environment first.
5. Run the deployment validation script against the preview URL:

   ```bash
   npm run check:deployment -- https://<preview-url> --token <test-user-access-token>
   ```

6. Complete the outstanding preview, real-TMDB, authentication, offline, migration, and CI checks in [`docs/release-checklist.md`](docs/release-checklist.md).

Do not change the existing production project's root directory as a shortcut: it currently serves the original application. Production cutover is a separate, gated activity and should only happen after the release checklist is satisfied.

## Documentation

| Document                                                   | Description                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| [`next/README.md`](next/README.md)                         | Detailed setup and implementation notes for the newer application |
| [`docs/architecture.md`](docs/architecture.md)             | Architecture decisions and application behaviour                  |
| [`docs/threat-model.md`](docs/threat-model.md)             | Security assumptions and threat considerations                    |
| [`docs/migration-plan.md`](docs/migration-plan.md)         | Database and library migration strategy                           |
| [`docs/migration-baseline.md`](docs/migration-baseline.md) | Canonical migration history and baseline                          |
| [`docs/release-checklist.md`](docs/release-checklist.md)   | Required release and cutover gates                                |
| [`supabase/README.md`](supabase/README.md)                 | Supabase setup and database guidance                              |
| [`supabase/AUTH_SETUP.md`](supabase/AUTH_SETUP.md)         | Authentication and redirect configuration                         |

## Acknowledgements

- [The Movie Database (TMDB)](https://www.themoviedb.org/) for movie and television metadata and imagery.
- [Supabase](https://supabase.com/) for authentication and PostgreSQL-backed services.

This product uses the TMDB API but is not endorsed or certified by TMDB.

---

**CinemaVault** — one place for the titles you love.
