/* Cached TMDB metadata repository. No network calls are made here. */
(function (global) {
  'use strict';

  const DB = () => global.CinemaVaultDB;
  const now = () => new Date().toISOString();

  async function get(movieId) {
    return DB().get(DB().STORES.METADATA, movieId);
  }

  async function save(movieId, input) {
    if (!movieId) throw new Error('movieId is required');

    const record = {
      movieId,
      tmdbId: input.tmdbId == null ? null : Number(input.tmdbId),
      tmdbMediaType: input.tmdbMediaType || null,
      poster: input.poster || null,
      backdrop: input.backdrop || null,
      overview: input.overview || null,
      tmdbRating: input.tmdbRating == null ? null : Number(input.tmdbRating),
      trailer: input.trailer || null,
      cachedAt: now()
    };

    await DB().put(DB().STORES.METADATA, record);
    return record;
  }

  async function remove(movieId) {
    return DB().remove(DB().STORES.METADATA, movieId);
  }

  async function listStale(maxAgeMs) {
    const maxAge = Number(maxAgeMs);
    if (!Number.isFinite(maxAge) || maxAge < 0) throw new Error('maxAgeMs must be a non-negative number');

    const threshold = Date.now() - maxAge;
    const rows = await DB().getAll(DB().STORES.METADATA);
    return rows.filter((row) => Date.parse(row.cachedAt) < threshold);
  }

  return global.CinemaVaultMetadataRepository = Object.freeze({
    get,
    save,
    remove,
    listStale
  });
})(window);
