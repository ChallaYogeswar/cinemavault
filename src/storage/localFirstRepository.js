/* Orchestrates local writes and durable sync intent. It deliberately does not know how Supabase works. */
(function (global) {
  'use strict';

  const Movies = () => global.CinemaVaultMovieRepository;
  const Queue = () => global.CinemaVaultSyncQueue;

  async function saveMovie(input) {
    const exists = input.id ? await Movies().get(input.id) : null;
    const movie = await Movies().upsert(input);

    await Queue().enqueue({
      operation: exists ? 'update' : 'create',
      entity: 'movie',
      entityId: movie.id,
      payload: movie
    });
    global.CinemaVaultSupabaseRepository?.flushQueue().catch((error) => console.error('[CinemaVault sync] Background sync failed:', error));
    return movie;
  }

  async function saveMovies(inputs) {
    const saved = [];
    for (const input of inputs) {
      const exists = input.id ? await Movies().get(input.id) : null;
      const movie = await Movies().upsert(input);
      await Queue().enqueue({
        operation: exists ? 'update' : 'create',
        entity: 'movie',
        entityId: movie.id,
        payload: movie
      });
      saved.push(movie);
    }
    // Caller flushes once after all local writes are queued.
    return saved;
  }

  async function deleteMovie(id) {
    const movie = await Movies().softDelete(id);
    if (!movie) return null;

    await Queue().enqueue({
      operation: 'delete',
      entity: 'movie',
      entityId: id,
      payload: movie
    });
    global.CinemaVaultSupabaseRepository?.flushQueue().catch((error) => console.error('[CinemaVault sync] Background sync failed:', error));
    return movie;
  }

  return global.CinemaVaultLocalFirstRepository = Object.freeze({
    saveMovie,
    saveMovies,
    deleteMovie
  });
})(window);
