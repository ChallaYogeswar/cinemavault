/* Persistent recommendation history for the local-first frontend. */
(function (global) {
  'use strict';

  const KEY = 'recommendation-history';
  const DB = () => global.CinemaVaultDB;

  async function read() {
    const row = await DB().get(DB().STORES.SETTINGS, KEY);
    return Array.isArray(row?.value) ? row.value : [];
  }

  async function write(items) {
    await DB().put(DB().STORES.SETTINGS, { key: KEY, value: items.slice(-40) });
    return items.slice(-40);
  }

  async function record({ movieId, genres = [], result = 'recommended' }) {
    const history = await read();
    history.push({
      movieId,
      genres: Array.isArray(genres) ? genres : [],
      result,
      at: new Date().toISOString()
    });
    return write(history);
  }

  async function recent(limit = 12) {
    const history = await read();
    return history.slice(-limit).reverse();
  }

  async function clear() {
    await DB().remove(DB().STORES.SETTINGS, KEY);
  }

  return global.CinemaVaultRecommendationHistory = Object.freeze({ read, write, record, recent, clear });
})(window);
