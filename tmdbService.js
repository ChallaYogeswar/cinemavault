(function () {
  'use strict';

  const API_BASE = 'https://api.themoviedb.org/3';
  const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
  const cache = new Map();

  // Preferred path: the site's own /api/tmdb proxy (key lives in Vercel env, nothing to set up per device).
  // Fallback: a personal key saved in this browser (used on hosts without the proxy, e.g. GitHub Pages).
  let proxyState = 'unknown'; // 'unknown' | 'ok' | 'missing'

  function getApiKey() {
    return window.CINEMAVAULT_TMDB_API_KEY || localStorage.getItem('cv3_tmdb_key') || '';
  }

  async function accessToken() {
    try { return (await window.CinemaVaultSupabase?.session?.())?.access_token || ''; } catch (_) { return ''; }
  }

  // Returns a Response-like object, or null if no TMDB access is available at all.
  async function tmdb(path, params) {
    if (proxyState !== 'missing') {
      try {
        const token = await accessToken();
        if (token) {
          const q = new URLSearchParams({ path, ...params });
          const res = await fetch('/api/tmdb?' + q, { headers: { Authorization: 'Bearer ' + token } });
          if (res.ok) { proxyState = 'ok'; return res; }
          if (res.status === 404 || res.status === 501 || res.status === 405) proxyState = 'missing';
          else if (res.status !== 401) return res;
        }
      } catch (_) { /* fall through to a personal key */ }
    }
    const key = getApiKey();
    if (!key) return null;
    const q = new URLSearchParams({ ...params, api_key: key });
    return fetch(API_BASE + path + '?' + q);
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

    if (!cleanTitle) return fallback(cleanTitle);

    try {
      const searchResponse = await tmdb('/search/multi', { query: cleanTitle });
      if (!searchResponse) return fallback(cleanTitle); // no proxy and no personal key: don't cache the miss
      if (!searchResponse.ok) throw new Error('TMDB search failed');
      const searchData = await searchResponse.json();
      const results=(searchData.results||[]).filter(r=>r.media_type==='movie'||r.media_type==='tv');
      const item=chooseResult(results,year);
      if(!item)return fallback(cleanTitle);

      const mediaType=item.media_type==='tv'?'tv':'movie';
      let videoData={results:[]};
      try{const videoResponse=await tmdb('/'+mediaType+'/'+item.id+'/videos',{});if(videoResponse&&videoResponse.ok)videoData=await videoResponse.json();}catch(error){}
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

  // Used by Settings to say plainly whether posters can load, and if not, why.
  async function diagnose() {
    const token = await accessToken();
    if (!token) return { ok: false, message: 'Sign in to check the poster service.' };
    let res;
    try {
      res = await fetch('/api/tmdb?' + new URLSearchParams({ path: '/search/multi', query: 'Inception' }), { headers: { Authorization: 'Bearer ' + token } });
    } catch (_) {
      return getApiKey() ? { ok: true, message: 'Using the TMDB key saved in this browser.' } : { ok: false, message: 'Could not reach this site’s poster service. Check your connection.' };
    }
    if (res.ok) { proxyState = 'ok'; return { ok: true, message: 'Poster service is working.' }; }
    if (getApiKey()) return { ok: true, message: 'Server key unavailable, so this browser’s own TMDB key is being used.' };
    if (res.status === 501) return { ok: false, message: 'The server has no TMDB key yet. In Vercel → Project → Settings → Environment Variables add TMDB_API_KEY (Production), then redeploy.' };
    if (res.status === 404 || res.status === 405) return { ok: false, message: 'The /api/tmdb function is not deployed. Make sure the api/ folder is in the repository and redeploy.' };
    if (res.status === 401) return { ok: false, message: 'Your sign-in expired. Sign out and back in.' };
    if (res.status === 502) return { ok: false, message: 'TMDB rejected the key saved in Vercel (TMDB_API_KEY). Use the API Key (v3) or the Read Access Token from themoviedb.org → Settings → API.' };
    return { ok: false, message: 'Poster service error (' + res.status + ').' };
  }

  window.CinemaVaultMetadata = { fetchCinemaMetadata, diagnose };
}());