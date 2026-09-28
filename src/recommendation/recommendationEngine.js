/* CinemaVault recommendation engine.
 * Global mode: soft backlog balancing + recent-genre penalty + weighted randomness.
 * Genre mode: pure random selection inside the chosen genre.
 */
(function (global) {
  'use strict';

  const History = () => global.CinemaVaultRecommendationHistory;

  const normalizeGenre = value => String(value || '')
    .replace(/[|;]/g, ',')
    .split(/[,/·&]+/)
    .map(x => x.trim())
    .filter(Boolean);

  function genresFor(movie) {
    const genres = normalizeGenre(movie.genre);
    return genres.length ? genres : ['Uncategorized'];
  }

  function inventory(movies) {
    const map = new Map();
    movies.filter(m => !m.watched && !m.deletedAt).forEach(movie => {
      genresFor(movie).forEach(genre => {
        if (!map.has(genre)) map.set(genre, []);
        map.get(genre).push(movie);
      });
    });
    return [...map.entries()]
      .map(([genre, moviesForGenre]) => ({ genre, count: moviesForGenre.length, movies: moviesForGenre }))
      .sort((a, b) => b.count - a.count);
  }

  function weightedChoice(items) {
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    if (!total) return items[Math.floor(Math.random() * items.length)]?.value || null;
    let cursor = Math.random() * total;
    for (const item of items) {
      cursor -= item.weight;
      if (cursor <= 0) return item.value;
    }
    return items[items.length - 1].value;
  }

  async function globalRecommendation(movies) {
    const eligible = movies.filter(m => !m.watched && !m.deletedAt);
    if (!eligible.length) return null;

    const recent = await History().recent(12);
    const recentGenres = recent.map(x => x.genres || []).flat();
    const recentMovieIds = new Set(recent.slice(0, 6).map(x => x.movieId));

    const rows = inventory(eligible);
    const weighted = rows.map(row => {
      const recentCount = recentGenres.filter(g => g === row.genre).length;
      const cooldown = recentCount ? Math.pow(0.42, Math.min(recentCount, 3)) : 1;
      const backlogWeight = Math.pow(row.count, 0.6);
      return {
        value: row.genre,
        weight: Math.max(0.05, backlogWeight * cooldown)
      };
    });

    const selectedGenre = weightedChoice(weighted);
    const row = rows.find(x => x.genre === selectedGenre) || rows[0];

    let candidates = row.movies.filter(movie => !recentMovieIds.has(movie.id));
    if (!candidates.length) candidates = row.movies.slice();

    const movie = candidates[Math.floor(Math.random() * candidates.length)];
    if (!movie) return null;

    await History().record({
      movieId: movie.id,
      genres: genresFor(movie),
      result: 'recommended'
    });

    return {
      movie,
      genre: selectedGenre,
      reason: row.count >= (rows[0]?.count || row.count) * 0.85
        ? selectedGenre + ' currently has a large unwatched backlog.'
        : 'Randomly selected with your backlog balance in mind.',
      inventory: rows
    };
  }

  async function genreRecommendation(movies, genre) {
    const target = String(genre || '').trim();
    const candidates = movies.filter(movie =>
      !movie.watched &&
      !movie.deletedAt &&
      genresFor(movie).some(g => g.toLowerCase() === target.toLowerCase())
    );
    if (!candidates.length) return null;

    const movie = candidates[Math.floor(Math.random() * candidates.length)];
    await History().record({
      movieId: movie.id,
      genres: genresFor(movie),
      result: 'genre-random'
    });

    return { movie, genre: target, inventory: inventory(movies) };
  }

  async function recordResult(movie, result) {
    if (!movie) return;
    await History().record({
      movieId: movie.id,
      genres: genresFor(movie),
      result
    });
  }

  return global.CinemaVaultRecommendationEngine = Object.freeze({
    normalizeGenre,
    genresFor,
    inventory,
    globalRecommendation,
    genreRecommendation,
    recordResult
  });
})(window);
