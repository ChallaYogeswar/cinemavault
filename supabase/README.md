# CinemaVault Supabase Foundation

This directory is the database foundation introduced by PR3.

## Scope

PR3 contains only:

- PostgreSQL schema for the CinemaVault library.
- Versioned migration.
- Row Level Security (RLS) policies.
- Development seed placeholder.
- Schema validation SQL.
- Supabase CLI configuration.

The existing CinemaVault frontend is intentionally untouched.

## Tables

### `public.movies`

Canonical user-owned library records.

Important fields:

- `owner_id`: Supabase Auth user UUID.
- `title` / `normalized_title`: user-facing and normalized identity fields.
- `media_type`: `movie` or `tv`.
- `year`: optional release year.
- watched state, user rating, verdict, technical notes, and optional shot link.
- `created_at`, `updated_at`, `deleted_at`: lifecycle/synchronization fields.

### `public.movie_metadata`

TMDB-derived data kept separate from user-owned library fields.

A row is linked one-to-one to a movie record and can store TMDB ID/type, poster, backdrop, overview, TMDB rating, and trailer key.

### `public.sync_state`

Per-user/per-device synchronization state. It stores the latest sync timestamp and an optional cursor.

## Security model

All three tables have RLS enabled.

The policies allow an authenticated user to read/write only rows whose `owner_id` matches `auth.uid()`.

Metadata does not expose a separate owner column; its policies resolve ownership through the parent `movies` row.

No service-role/secret key is stored in this repository.

## Local validation

Install/login to the Supabase CLI, then from the repository root:

```bash
supabase start
supabase db reset
supabase db lint
supabase test db
```

The migration is applied by `db reset`, and `supabase/validation.sql` can be executed against the local database to verify the required tables, RLS, policies, and indexes.

For a linked remote project, review the migration locally before applying it remotely:

```bash
supabase db push
```

Do not commit `.env`, service-role keys, database passwords, or other secrets.

## PR3 boundary

This PR does **not**:

- connect the browser application to Supabase;
- replace IndexedDB;
- remove Google Sheets;
- redesign the frontend;
- add authentication UI;
- add the synchronization engine.

Those are later PRs.
