/* Movie repository for CinemaVault's local-first layer.
 * This module is intentionally UI-independent.
 */
(function (global) {
  'use strict';

  const DB = () => global.CinemaVaultDB;
  const now = () => new Date().toISOString();

  function normalizeTitle(title) {
    return String(title ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\(series\)|\(show\)|\(tv\)/gi, '')
      .replace(/\s+season\s+\d+$/i, '')
      .trim();
  }

  function toMovie(input) {
    const timestamp = now();
    const movie = {
      id: input.id || crypto.randomUUID(),
      title: String(input.title || '').trim(),
      normalized_title: input.normalized_title || normalizeTitle(input.title),
      media_type: input.media_type === 'tv' ? 'tv' : 'movie',
      year: input.year == null || input.year === '' ? null : Number(input.year),
      genre: input.genre || null,
      runtime_minutes: input.runtime_minutes == null ? null : Number(input.runtime_minutes),
      watched: Boolean(input.watched),
      watched_on: input.watched_on || null,
      user_rating: input.user_rating == null ? null : Number(input.user_rating),
      verdict: input.verdict || null,
      technical_notes: input.technical_notes || null,
      shot_link: input.shot_link || null,
      createdAt: input.createdAt || timestamp,
      updatedAt: timestamp,
      deletedAt: input.deletedAt || null
    };

    if (!movie.title) throw new Error('Movie title is required');
    if (!movie.normalized_title) throw new Error('Normalized movie title is required');
    if (movie.user_rating != null && (movie.user_rating < 0 || movie.user_rating > 10)) {
      throw new Error('User rating must be between 0 and 10');
    }
    if (movie.watched === false) movie.watched_on = null;

    return movie;
  }

  async function list(options = {}) {
    let rows = await DB().getAll(DB().STORES.MOVIES);
    if (options.includeDeleted !== true) rows = rows.filter((row) => !row.deletedAt);
    if (options.mediaType) rows = rows.filter((row) => row.media_type === options.mediaType);
    if (options.watched != null) rows = rows.filter((row) => row.watched === Boolean(options.watched));

    rows.sort((a, b) => String(a.normalized_title).localeCompare(String(b.normalized_title)));
    return rows;
  }

  async function get(id) {
    return DB().get(DB().STORES.MOVIES, id);
  }

  async function save(input) {
    const movie = toMovie(input);
    const existing = await get(movie.id);

    if (existing && movie.createdAt === movie.updatedAt) {
      movie.createdAt = existing.createdAt;
    }

    await DB().put(DB().STORES.MOVIES, movie);
    return movie;
  }

  async function upsert(input) {
    return save(input);
  }

  async function softDelete(id) {
    const existing = await get(id);
    if (!existing) return null;

    const deleted = {
      ...existing,
      deletedAt: now(),
      updatedAt: now()
    };
    await DB().put(DB().STORES.MOVIES, deleted);
    return deleted;
  }

  async function removePermanently(id) {
    await DB().remove(DB().STORES.MOVIES, id);
    await DB().remove(DB().STORES.METADATA, id);
    return id;
  }

  async function findDuplicate(input) {
    const normalized = normalizeTitle(input.title);
    const mediaType = input.media_type === 'tv' ? 'tv' : 'movie';
    const year = input.year == null || input.year === '' ? null : Number(input.year);

    const rows = await list({ includeDeleted: false });
    return rows.find((row) =>
      row.normalized_title === normalized &&
      row.media_type === mediaType &&
      row.year === year
    ) || null;
  }

  return global.CinemaVaultMovieRepository = Object.freeze({
    normalizeTitle,
    toMovie,
    list,
    get,
    save,
    upsert,
    softDelete,
    removePermanently,
    findDuplicate
  });
})(window);
