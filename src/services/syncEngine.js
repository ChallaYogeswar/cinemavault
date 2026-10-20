/* CinemaVault PR6 — Supabase <-> IndexedDB synchronization.
 * Pushes the durable local queue first, then pulls newer remote records.
 */
(function (global) {
  'use strict';

  const PAGE_SIZE = 500;

  function client() {
    return global.CinemaVaultSupabase?.getClient?.() || null;
  }

  function iso(value) {
    return value ? new Date(value).toISOString() : null;
  }

  function movieToRemote(movie, ownerId) {
    return {
      id: movie.id,
      owner_id: ownerId,
      title: movie.title,
      normalized_title: movie.normalized_title,
      media_type: movie.media_type,
      year: movie.year,
      genre: movie.genre,
      runtime_minutes: movie.runtime_minutes,
      watched: movie.watched,
      watched_on: movie.watched_on,
      user_rating: movie.user_rating == null ? null : Math.min(5, Math.max(0, Number(movie.user_rating))),
      verdict: movie.verdict,
      technical_notes: movie.technical_notes,
      shot_link: movie.shot_link,
      created_at: movie.createdAt,
      updated_at: movie.updatedAt,
      deleted_at: movie.deletedAt
    };
  }

  function remoteToMovie(row) {
    return {
      id: row.id,
      title: row.title,
      normalized_title: row.normalized_title,
      media_type: row.media_type,
      year: row.year,
      genre: row.genre,
      runtime_minutes: row.runtime_minutes,
      watched: row.watched,
      watched_on: row.watched_on,
      user_rating: row.user_rating,
      verdict: row.verdict,
      technical_notes: row.technical_notes,
      shot_link: row.shot_link,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at
    };
  }

  function metadataToRemote(metadata) {
    return {
      movie_id: metadata.movieId,
      tmdb_id: metadata.tmdbId,
      tmdb_media_type: metadata.tmdbMediaType,
      poster_url: metadata.poster,
      backdrop_url: metadata.backdrop,
      overview: metadata.overview,
      tmdb_rating: metadata.tmdbRating,
      trailer_key: metadata.trailer,
      metadata_updated_at: metadata.cachedAt
    };
  }

  function remoteToMetadata(row) {
    return {
      movieId: row.movie_id,
      tmdbId: row.tmdb_id,
      tmdbMediaType: row.tmdb_media_type,
      poster: row.poster_url,
      backdrop: row.backdrop_url,
      overview: row.overview,
      tmdbRating: row.tmdb_rating,
      trailer: row.trailer_key,
      cachedAt: row.metadata_updated_at
    };
  }

  async function requireSession() {
    const session = await global.CinemaVaultSupabase.session();
    if (!session?.user) throw new Error('Sign in to Supabase before syncing.');
    return session;
  }

  const PUSH_CHUNK = 200;
  const MAX_RETRIES = 5;

  function identityMatch(query, movie) {
    query = query.eq('normalized_title', movie.normalized_title).eq('media_type', movie.media_type).is('deleted_at', null);
    return movie.year == null ? query.is('year', null) : query.eq('year', movie.year);
  }

  // The database enforces one live row per (owner, title, type, year). If this device created a
  // title the cloud already has under another id, adopt the cloud row instead of failing forever.
  async function adoptRemoteDuplicate(instance, userId, movie) {
    const { data, error } = await identityMatch(
      instance.from('movies').select('*').eq('owner_id', userId), movie
    ).limit(1);
    if (error || !data?.length) return false;
    const remote = data[0];
    if (remote.id !== movie.id) {
      await global.CinemaVaultDB.remove(global.CinemaVaultDB.STORES.MOVIES, movie.id);
      await global.CinemaVaultDB.put(global.CinemaVaultDB.STORES.MOVIES, remoteToMovie(remote));
    }
    return true;
  }

  async function pushQueue(instance, userId, options = {}) {
    const Queue = global.CinemaVaultSyncQueue;
    const pending = await Queue.list('pending');
    const failed = (await Queue.list('failed')).filter(row => options.retryFailed || row.retryCount < MAX_RETRIES);
    const queue = pending.concat(failed).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    // Collapse repeated edits of one record into its newest state.
    const latestMovie = new Map();
    const latestMeta = new Map();
    const superseded = [];
    for (const item of queue) {
      const map = item.entity === 'movie' ? latestMovie : item.entity === 'movie_metadata' ? latestMeta : null;
      if (!map) { await Queue.markFailed(item.id, new Error('Unsupported sync entity: ' + item.entity)); continue; }
      if (map.has(item.entityId)) superseded.push(map.get(item.entityId));
      map.set(item.entityId, item);
    }
    for (const old of superseded) await Queue.acknowledge(old.id);

    const movieItems = [...latestMovie.values()];
    for (let i = 0; i < movieItems.length; i += PUSH_CHUNK) {
      const chunk = movieItems.slice(i, i + PUSH_CHUNK);
      const rows = chunk.map(item => movieToRemote(item.payload, userId));
      const { error } = await instance.from('movies').upsert(rows, { onConflict: 'id' });
      if (!error) { for (const item of chunk) await Queue.acknowledge(item.id); continue; }

      // Find which record(s) the database rejected.
      for (const item of chunk) {
        try {
          const { error: oneError } = await instance.from('movies').upsert(movieToRemote(item.payload, userId), { onConflict: 'id' });
          if (oneError) {
            if (oneError.code === '23505' && await adoptRemoteDuplicate(instance, userId, item.payload)) {
              await Queue.acknowledge(item.id);
              continue;
            }
            throw oneError;
          }
          await Queue.acknowledge(item.id);
        } catch (err) {
          await Queue.markFailed(item.id, err);
        }
      }
    }

    const metaItems = [...latestMeta.values()];
    for (let i = 0; i < metaItems.length; i += PUSH_CHUNK) {
      const chunk = metaItems.slice(i, i + PUSH_CHUNK);
      const { error } = await instance.from('movie_metadata')
        .upsert(chunk.map(item => metadataToRemote(item.payload)), { onConflict: 'movie_id' });
      if (!error) { for (const item of chunk) await Queue.acknowledge(item.id); continue; }
      for (const item of chunk) {
        const { error: oneError } = await instance.from('movie_metadata')
          .upsert(metadataToRemote(item.payload), { onConflict: 'movie_id' });
        if (oneError) await Queue.markFailed(item.id, oneError); else await Queue.acknowledge(item.id);
      }
    }
  }

  async function pullMovies(instance, cursor) {
    const DB = global.CinemaVaultDB;
    let from = 0;
    let newest = cursor || null;
    let changed = 0;

    // A cleared browser must re-download everything, whatever the saved cursor says.
    const localCount = (await DB.getAll(DB.STORES.MOVIES)).length;
    if (!localCount) { cursor = null; newest = null; }

    while (true) {
      let query = instance.from('movies').select('*')
        .order('updated_at', { ascending: true }).order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (cursor) query = query.gte('updated_at', cursor);
      const { data, error } = await query;
      if (error) throw error;
      if (!data?.length) break;

      const locals = await DB.getMany(DB.STORES.MOVIES, data.map(row => row.id));
      const writes = [];
      data.forEach((row, index) => {
        const local = locals[index];
        const remoteUpdated = Date.parse(row.updated_at || '') || 0;
        const localUpdated = Date.parse(local?.updatedAt || '') || 0;
        if (!local || remoteUpdated > localUpdated) { writes.push(remoteToMovie(row)); changed += 1; }
        if (!newest || row.updated_at > newest) newest = row.updated_at;
      });
      await DB.putMany(DB.STORES.MOVIES, writes);

      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return { newest, changed };
  }

  async function pullMetadata(instance) {
    const DB = global.CinemaVaultDB;
    let from = 0;
    while (true) {
      const { data, error } = await instance.from('movie_metadata').select('*')
        .order('movie_id', { ascending: true }).range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data?.length) break;
      const locals = await DB.getMany(DB.STORES.METADATA, data.map(row => row.movie_id));
      const writes = [];
      data.forEach((row, index) => {
        const remoteUpdated = Date.parse(row.metadata_updated_at || '') || 0;
        const localUpdated = Date.parse(locals[index]?.cachedAt || '') || 0;
        if (!locals[index] || remoteUpdated > localUpdated) writes.push(remoteToMetadata(row));
      });
      await DB.putMany(DB.STORES.METADATA, writes);
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }

  let activeSync = null;
  let rerunRequested = false;

  async function syncNow(options = {}) {
    if (activeSync) {
      rerunRequested = true;
      return activeSync;
    }
    activeSync = (async () => {
      let result;
      do {
        rerunRequested = false;
        result = await syncNowInternal(options);
      } while (rerunRequested);
      return result;
    })();
    try { return await activeSync; } finally { activeSync = null; }
  }

  async function syncNowInternal(options = {}) {
    const instance = client();
    if (!instance) return { status: 'not-configured', pushed: 0, pulled: 0 };

    const session = await requireSession();
    const previous = await global.CinemaVaultSyncStateRepository.get('default');
    await global.CinemaVaultSyncQueue.resetProcessing();

    const before = (await global.CinemaVaultSyncQueue.list('pending')).length;
    let pushError = null;
    // View-only accounts only download; they never push.
    const canWrite = global.CinemaVaultAuth ? global.CinemaVaultAuth.canWrite() : true;
    if (canWrite) { try { await pushQueue(instance, session.user.id, options); } catch (error) { pushError = error; } }
    const after = (await global.CinemaVaultSyncQueue.list('pending')).length;

    // Always pull, even if some pushes failed, so cloud data still reaches this device.
    const { newest, changed } = await pullMovies(instance, previous?.cursor || null);
    await pullMetadata(instance);

    const failedAfterPush = await global.CinemaVaultSyncQueue.list('failed');
    const lastError = pushError?.message
      || (failedAfterPush.length
        ? failedAfterPush.length + ' cloud change(s) failed: ' + (failedAfterPush[failedAfterPush.length - 1]?.lastError || 'unknown error')
        : null);

    await global.CinemaVaultSyncStateRepository.save({
      id: 'default',
      deviceId: await global.CinemaVaultSyncStateRepository.getDeviceId(),
      lastSyncedAt: new Date().toISOString(),
      cursor: newest || previous?.cursor || null,
      syncStatus: lastError ? 'error' : 'idle',
      lastError
    });
    if (lastError) throw new Error(lastError);

    const rows = await global.CinemaVaultMovieRepository.list({ includeDeleted: false });
    return { status: 'synced', pushed: Math.max(0, before - after), pulled: rows.length, changed };
  }

  async function syncSafe(options) {
    try {
      const result = await syncNow(options);
      return result;
    } catch (error) {
      await global.CinemaVaultSyncStateRepository.markError(error);
      return { status: 'error', error };
    }
  }

  async function uploadLocalLibrary() {
    const instance = client();
    if (!instance) throw new Error('Save the Supabase connection first.');
    const session = await requireSession();
    const { count, error } = await instance.from('movies').select('id', { count: 'exact', head: true });
    if (error) throw error;
    if (Number(count || 0) > 0) {
      throw new Error('This account already has cloud movies. Use normal sync to avoid duplicating or mixing libraries.');
    }

    const localMovies = await global.CinemaVaultMovieRepository.list({ includeDeleted: false });
    if (!localMovies.length) return { status: 'empty', pushed: 0 };
    const queued = await global.CinemaVaultSyncQueue.list('pending');
    const existingIds = new Set(queued.filter(row => row.entity === 'movie').map(row => row.entityId));
    for (const movie of localMovies) {
      if (!existingIds.has(movie.id)) {
        await global.CinemaVaultSyncQueue.enqueue({
          operation: 'create', entity: 'movie', entityId: movie.id, payload: movie
        });
      }
      const metadata = await global.CinemaVaultMetadataRepository.get(movie.id);
      if (metadata) {
        const metadataQueued = queued.some(row => row.entity === 'movie_metadata' && row.entityId === movie.id);
        if (!metadataQueued) {
          await global.CinemaVaultSyncQueue.enqueue({
            operation: 'create', entity: 'movie_metadata', entityId: movie.id, payload: metadata
          });
        }
      }
    }
    const result = await syncNow();
    if (result.status !== 'synced') throw result.error || new Error('Initial library upload did not complete.');
    return { ...result, imported: localMovies.length, ownerId: session.user.id };
  }

  function start() {
    const run = async () => {
      if (!global.CinemaVaultSupabase?.configured?.()) return { status: 'not-configured' };
      try {
        const session = await global.CinemaVaultSupabase.session();
        if (!session?.user) {
          const out = { status: 'signed-out' };
          if (typeof global.CinemaVaultOnSyncResult === 'function') global.CinemaVaultOnSyncResult(out);
          return out;
        }
        const result = await syncSafe();
        if (typeof global.CinemaVaultOnSyncResult === 'function') global.CinemaVaultOnSyncResult(result);
        if (result.status === 'synced' && result.changed && typeof global.CinemaVaultAppRefresh === 'function') {
          global.CinemaVaultAppRefresh();
        }
        return result;
      } catch (error) {
        return { status: 'error', error };
      }
    };

    if (!start.onlineListenerAttached) {
      start.onlineListenerAttached = true;
      window.addEventListener('online', () => { void run(); });
    }
    // Pull remote records on startup for an already-configured, signed-in user.
    return global.navigator?.onLine ? run() : Promise.resolve({ status: 'offline' });
  }

  return global.CinemaVaultSyncEngine = Object.freeze({
    syncNow,
    syncSafe,
    uploadLocalLibrary,
    start
  });
})(window);
