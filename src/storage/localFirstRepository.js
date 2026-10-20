/* Orchestrates local writes and durable sync intent. It deliberately does not know how Supabase works. */
(function (global) {
  'use strict';

  const Movies = () => global.CinemaVaultMovieRepository;
  const Queue = () => global.CinemaVaultSyncQueue;

  // View-only accounts never write (the database refuses it anyway); fail early with a clear message.
  function assertCanWrite() {
    if (global.CinemaVaultAuth && !global.CinemaVaultAuth.canWrite()) {
      throw new Error('This is a view-only account — only the vault owner can make changes.');
    }
  }

  function requestSync() {
    if (!global.navigator?.onLine) return;
    // Queue writes remain durable even when auth/configuration is unavailable.
    // The sync engine reports status and retries on the next online/auth event.
    Promise.resolve().then(() => global.CinemaVaultSyncEngine?.syncSafe?.()).then(result => {
      if (typeof global.CinemaVaultOnSyncResult === 'function') global.CinemaVaultOnSyncResult(result);
      if (result?.status === 'synced' && result.changed && typeof global.CinemaVaultAppRefresh === 'function') {
        return global.CinemaVaultAppRefresh();
      }
    }).catch(error => console.warn('[CinemaVault sync]', error));
  }

  async function saveMovie(input) {
    assertCanWrite();
    const exists = input.id ? await Movies().get(input.id) : null;
    const movie = await Movies().upsert(input);

    await Queue().enqueue({
      operation: exists ? 'update' : 'create',
      entity: 'movie',
      entityId: movie.id,
      payload: movie
    });
    requestSync();
    return movie;
  }

  // Bulk add: one IndexedDB transaction and one sync request for the whole batch.
  async function saveMovies(inputs) {
    assertCanWrite();
    const movies = inputs.map(input => Movies().toMovie(input));
    const stamp = new Date().toISOString();
    const operations = movies.map(movie => ({
      operation: 'create', entity: 'movie', entityId: movie.id, payload: movie,
      status: Queue().STATUS.PENDING, retryCount: 0, lastError: null, createdAt: stamp, updatedAt: stamp
    }));
    await global.CinemaVaultDB.writeMoviesWithQueue(movies, operations);
    requestSync();
    return movies;
  }

  async function saveMetadata(movieId, input) {
    const Metadata = () => global.CinemaVaultMetadataRepository;
    const metadata = await Metadata().save(movieId, input);
    // Viewers keep fetched posters in their own browser cache only; the owner's copy syncs to the cloud.
    if (global.CinemaVaultAuth && !global.CinemaVaultAuth.canWrite()) return metadata;
    await Queue().enqueue({
      operation: 'update',
      entity: 'movie_metadata',
      entityId: movieId,
      payload: metadata
    });
    requestSync();
    return metadata;
  }

  async function deleteMovie(id) {
    assertCanWrite();
    const movie = await Movies().softDelete(id);
    if (!movie) return null;

    await Queue().enqueue({
      operation: 'delete',
      entity: 'movie',
      entityId: id,
      payload: movie
    });
    requestSync();
    return movie;
  }

  return global.CinemaVaultLocalFirstRepository = Object.freeze({
    saveMovie,
    saveMovies,
    saveMetadata,
    deleteMovie
  });
})(window);
