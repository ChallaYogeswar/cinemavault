(function () {
  'use strict';

  const API_BASE = 'https://api.themoviedb.org/3';
  const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
  const cache = new Map();

  function getApiKey() {
    return window.CINEMAVAULT_TMDB_API_KEY || localStorage.getItem('cv3_tmdb_key') || '';
  }

  function sanitizeTitle(rawTitle) {
    return String(rawTitle || '')
      .replace(/\s*[\(\[]\s*(Series|Show|Mini-Series|Miniseries|TV|Anime)\s*[\)\]]/gi, '')
      .replace(/\s+Season\s+\d+\b/gi, '')
      .trim();
  }

  function cacheKey(title, year) {
    return 'cv3_tmdb_' + sanitizeTitle(title).toLowerCase() + '_' + String(year || '');
  }

  function fallback(title) {
    return {
      poster: null,
      backdrop: null,
      trailerKey: null,
      youtubeUrl: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(sanitizeTitle(title) + ' official trailer')
    };
  }

  function chooseResult(results, year) {
    if (!Array.isArray(results) || !results.length) return null;
    const normalizedYear=String(year||'');
    if(normalizedYear){const exact=results.find(r=>String(r.release_date||r.first_air_date||'').startsWith(normalizedYear));if(exact)return exact;}
    return results.find(r=>r.poster_path)||results[0];
  }

  async function fetchCinemaMetadata(title, year) {
    const cleanTitle = sanitizeTitle(title);
    const key = cacheKey(cleanTitle, year);
    if (cache.has(key)) return cache.get(key);
    try {
      const stored = localStorage.getItem(key);
      if (stored) { const parsed=JSON.parse(stored); cache.set(key, parsed); return parsed; }
    } catch (error) {}

    const apiKey = getApiKey();
    if (!apiKey || !cleanTitle) return fallback(cleanTitle);

    try {
      const query = new URLSearchParams({ api_key: apiKey, query: cleanTitle });
      const searchResponse = await fetch(API_BASE + '/search/multi?' + query);
      if (!searchResponse.ok) throw new Error('TMDB search failed');
      const searchData = await searchResponse.json();
      const results=(searchData.results||[]).filter(r=>r.media_type==='movie'||r.media_type==='tv');
      const item=chooseResult(results,year);
      if(!item)return fallback(cleanTitle);

      const mediaType=item.media_type==='tv'?'tv':'movie';
      let videoData={results:[]};
      try{const videoResponse=await fetch(API_BASE+'/'+mediaType+'/'+item.id+'/videos?api_key='+encodeURIComponent(apiKey));if(videoResponse.ok)videoData=await videoResponse.json();}catch(error){}
      const trailer=(videoData.results||[]).find(video=>video.site==='YouTube'&&(video.type==='Trailer'||video.type==='Teaser'))||(videoData.results||[]).find(video=>video.site==='YouTube');
      const result={
        id:item.id,
        mediaType,
        title:item.title||item.name||cleanTitle,
        poster:item.poster_path?IMAGE_BASE+item.poster_path:null,
        backdrop:item.backdrop_path?'https://image.tmdb.org/t/p/w1280'+item.backdrop_path:null,
        voteAverage:item.vote_average?item.vote_average.toFixed(1):null,
        overview:item.overview||'',
        trailerKey:trailer?.key||null,
        youtubeUrl:trailer?'https://www.youtube.com/watch?v='+trailer.key:fallback(cleanTitle).youtubeUrl
      };
      cache.set(key,result);try{localStorage.setItem(key,JSON.stringify(result));}catch(error){}
      return result;
    } catch (error) { return fallback(cleanTitle); }
  }

  window.CinemaVaultMetadata = { fetchCinemaMetadata };
}());