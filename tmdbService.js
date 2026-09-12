(function () {
  'use strict';

  const API_BASE = 'https://api.themoviedb.org/3';
  const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
  const cache = new Map();

  function getApiKey() {
    return window.CINEMAVAULT_TMDB_API_KEY || localStorage.getItem('cv3_tmdb_key') || '';
  }

  function cacheKey(title, year) {
    return 'cv3_tmdb_' + String(title).toLowerCase().trim() + '_' + String(year || '');
  }

  function fallback(title) {
    return {
      poster: null,
      backdrop: null,
      trailerKey: null,
      youtubeUrl: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(title + ' official trailer')
    };
  }

  async function fetchCinemaMetadata(title, year) {
    const key = cacheKey(title, year);
    if (cache.has(key)) return cache.get(key);

    try {
      const stored = localStorage.getItem(key);
      if (stored) {
        const parsed = JSON.parse(stored);
        cache.set(key, parsed);
        return parsed;
      }
    } catch (error) {
      // Local metadata cache is optional.
    }

    const apiKey = getApiKey();
    if (!apiKey || !title) return fallback(title);

    try {
      const query = new URLSearchParams({ api_key: apiKey, query: title });
      if (year) query.set('year', year);
      const searchResponse = await fetch(API_BASE + '/search/movie?' + query);
      if (!searchResponse.ok) throw new Error('TMDB search failed');
      const searchData = await searchResponse.json();
      const item = searchData.results?.[0];
      if (!item) return fallback(title);

      const videoResponse = await fetch(API_BASE + '/movie/' + item.id + '/videos?api_key=' + encodeURIComponent(apiKey));
      const videoData = videoResponse.ok ? await videoResponse.json() : { results: [] };
      const trailer = (videoData.results || []).find(video => video.site === 'YouTube' && (video.type === 'Trailer' || video.type === 'Teaser'));
      const result = {
        poster: item.poster_path ? IMAGE_BASE + item.poster_path : null,
        backdrop: item.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + item.backdrop_path : null,
        voteAverage: item.vote_average ? item.vote_average.toFixed(1) : null,
        overview: item.overview || '',
        trailerKey: trailer?.key || null,
        youtubeUrl: trailer ? 'https://www.youtube.com/watch?v=' + trailer.key : fallback(title).youtubeUrl
      };
      cache.set(key, result);
      try { localStorage.setItem(key, JSON.stringify(result)); } catch (error) { /* Cache is optional. */ }
      return result;
    } catch (error) {
      return fallback(title);
    }
  }

  window.CinemaVaultMetadata = { fetchCinemaMetadata };
}());