# CinemaVault PR4 — IndexedDB Local-First Foundation

PR4 introduces the browser storage layer without changing the existing CinemaVault UI.

## Stores

| Store | Purpose |
| --- | --- |
| `movies` | Local canonical copy of library records |
| `metadata` | Cached TMDB metadata |
| `pending_operations` | Durable mutations waiting for a future remote sync |
| `settings` | Device-local settings such as the generated device ID |
| `sync_state` | Local sync cursor/status for this browser/device |

## Write path

The intended local-first path is:

```
UI action
  -> LocalFirstRepository
  -> IndexedDB
  -> pending_operations
  -> future Sync Engine
  -> Supabase
```

PR4 stops before the Supabase step.

A successful local write is not treated as a successful remote sync. The durable queue is the hand-off point between the two.

## Read path

```
UI
  -> MovieRepository
  -> IndexedDB
```

PR4 does not modify the existing UI to use this path yet.

## Conflict model prepared by PR4

Records carry `updatedAt` and soft-delete timestamps. The queue preserves the complete mutation payload. These primitives are intended for the later sync engine.

The sync engine should implement:

- deterministic ordering by queue creation time;
- retry with bounded backoff;
- remote/local timestamp comparison;
- tombstone handling so deleted records cannot be accidentally resurrected;
- explicit handling of failed operations.

PR4 intentionally does not implement conflict resolution or network synchronization.

## Browser requirements

CinemaVault requires IndexedDB and Web Crypto `crypto.randomUUID()`. Current desktop Chrome, Edge, Firefox, and Safari support both.

The database is same-origin and should be treated as local application data, not a secure secrets store. Never place Supabase service-role keys or other privileged secrets in IndexedDB.

## Testing

Serve the repository over HTTP and open:

`tests/storage-test-runner.html`

The runner verifies:

- local movie persistence;
- title normalization;
- metadata caching;
- durable mutation queue;
- duplicate detection;
- soft deletion.

No frontend page is modified by PR4.
