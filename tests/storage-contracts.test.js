/*
 * PR4 storage contract tests.
 *
 * These are browser-oriented smoke tests and intentionally avoid a test framework
 * dependency. Open tests/storage-test-runner.html through a local HTTP server.
 */
(function () {
  'use strict';

  const results = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  async function run() {
    await CinemaVaultDB.clearAll();

    const movie = await CinemaVaultMovieRepository.save({
      title: 'Dune: Part Two',
      media_type: 'movie',
      year: 2024
    });

    assert(movie.id, 'movie receives an id');
    assert(movie.normalized_title === 'dune: part two', 'title is normalized');
    assert((await CinemaVaultMovieRepository.get(movie.id)).title === 'Dune: Part Two', 'movie can be read');

    await CinemaVaultMetadataRepository.save(movie.id, {
      tmdbId: 693134,
      tmdbMediaType: 'movie',
      poster: '/poster.jpg'
    });
    assert((await CinemaVaultMetadataRepository.get(movie.id)).tmdbId === 693134, 'metadata is cached');

    await CinemaVaultSyncQueue.enqueue({
      operation: 'create',
      entity: 'movie',
      entityId: movie.id,
      payload: movie
    });
    assert((await CinemaVaultSyncQueue.list()).length === 1, 'mutation is durable in queue');

    const duplicate = await CinemaVaultMovieRepository.findDuplicate({
      title: 'Dune: Part Two',
      media_type: 'movie',
      year: 2024
    });
    assert(duplicate?.id === movie.id, 'duplicate identity is detected');

    await CinemaVaultMovieRepository.softDelete(movie.id);
    assert((await CinemaVaultMovieRepository.list()).length === 0, 'soft deleted records are hidden');

    results.push('PASS: movie repository');
    results.push('PASS: metadata repository');
    results.push('PASS: durable sync queue');
    results.push('PASS: duplicate detection');
    results.push('PASS: soft delete');

    document.getElementById('output').textContent = results.join('\n');
  }

  run().catch((error) => {
    document.getElementById('output').textContent = 'FAIL: ' + error.message;
  });
})();
