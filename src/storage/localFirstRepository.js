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
    return movie;
  }

  async function saveMetadata(movieId, input) {
    const Metadata = () => global.CinemaVaultMetadataRepository;
    const metadata = await Metadata().save(movieId, input);
    await Queue().enqueue({
      operation: 'update',
      entity: 'movie_metadata',
      entityId: movieId,
      payload: metadata
    });
    return metadata;
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
    return movie;
  }

  return global.CinemaVaultLocalFirstRepository = Object.freeze({
    saveMovie,
    saveMetadata,
    deleteMovie
  });
})(window);
