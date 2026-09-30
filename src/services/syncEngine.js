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
      user_rating: movie.user_rating,
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

  async function pushQueue(instance, userId) {
    const pending = await global.CinemaVaultSyncQueue.list('pending');
    const failed = await global.CinemaVaultSyncQueue.list('failed');
    const queue = pending.concat(failed.filter(row => row.retryCount < 5)
      .map(row => ({ ...row, status: 'pending' })));

    for (const item of queue) {
      await global.CinemaVaultSyncQueue.update(item.id, { status: 'processing' });
      try {
        if (item.entity === 'movie') {
          const payload = movieToRemote(item.payload, userId);
          const { error } = await instance.from('movies').upsert(payload, { onConflict: 'id' });
          if (error) throw error;
        } else if (item.entity === 'movie_metadata') {
          const payload = metadataToRemote(item.payload);
          const { error } = await instance.from('movie_metadata').upsert(payload, { onConflict: 'movie_id' });
          if (error) throw error;
        } else {
          throw new Error('Unsupported sync entity: ' + item.entity);
        }
        await global.CinemaVaultSyncQueue.acknowledge(item.id);
      } catch (error) {
        await global.CinemaVaultSyncQueue.markFailed(item.id, error);
      }
    }
  }

  async function pullMovies(instance, cursor) {
    let from = 0;
    let newest = cursor || null;

    while (true) {
      let query = instance.from('movies').select('*').order('updated_at', { ascending: true }).range(from, from + PAGE_SIZE - 1);
      if (cursor) query = query.gt('updated_at', cursor);
      const { data, error } = await query;
      if (error) throw error;
      if (!data?.length) break;

      for (const row of data) {
        const local = await global.CinemaVaultMovieRepository.get(row.id);
        const remoteUpdated = Date.parse(row.updated_at || '') || 0;
        const localUpdated = Date.parse(local?.updatedAt || '') || 0;
        if (!local || remoteUpdated >= localUpdated) {
          await global.CinemaVaultDB.put(global.CinemaVaultDB.STORES.MOVIES, remoteToMovie(row));
        }
        if (!newest || row.updated_at > newest) newest = row.updated_at;
      }

      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return newest;
  }

  async function pullMetadata(instance) {
    let from = 0;
    while (true) {
      const { data, error } = await instance.from('movie_metadata').select('*').range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data?.length) break;
      for (const row of data) {
        const local = await global.CinemaVaultMetadataRepository.get(row.movie_id);
        const remoteUpdated = Date.parse(row.metadata_updated_at || '') || 0;
        const localUpdated = Date.parse(local?.cachedAt || '') || 0;
        if (!local || remoteUpdated >= localUpdated) {
          await global.CinemaVaultDB.put(global.CinemaVaultDB.STORES.METADATA, remoteToMetadata(row));
        }
      }
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }

  async function syncNow() {
    const instance = client();
    if (!instance) return { status: 'not-configured', pushed: 0, pulled: 0 };

    const session = await requireSession();
    const previous = await global.CinemaVaultSyncStateRepository.get('default');
    await global.CinemaVaultSyncQueue.resetProcessing();

    const before = (await global.CinemaVaultSyncQueue.list('pending')).length;
    await pushQueue(instance, session.user.id);
    const after = (await global.CinemaVaultSyncQueue.list('pending')).length;

    const newest = await pullMovies(instance, previous?.cursor || null);
    await pullMetadata(instance);

    await global.CinemaVaultSyncStateRepository.save({
      id: 'default',
      deviceId: await global.CinemaVaultSyncStateRepository.getDeviceId(),
      lastSyncedAt: new Date().toISOString(),
      cursor: newest || previous?.cursor || null,
      syncStatus: 'idle',
      lastError: null
    });

    const rows = await global.CinemaVaultMovieRepository.list({ includeDeleted: false });
    return { status: 'synced', pushed: Math.max(0, before - after), pulled: rows.length };
  }

  async function syncSafe() {
    try {
      const result = await syncNow();
      return result;
    } catch (error) {
      await global.CinemaVaultSyncStateRepository.markError(error);
      return { status: 'error', error };
    }
  }

  function start() {
    const run = () => syncSafe().then(() => {
      if (typeof global.CinemaVaultAppRefresh === 'function') global.CinemaVaultAppRefresh();
    });
    window.addEventListener('online', run);
    return run;
  }

  return global.CinemaVaultSyncEngine = Object.freeze({
    syncNow,
    syncSafe,
    start
  });
})(window);
