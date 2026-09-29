/* CinemaVault PR5 — cinematic frontend.
 * UI reads/writes the PR4 IndexedDB layer. Supabase synchronization is intentionally
 * not implemented here; queued mutations remain available for the future sync engine.
 */
(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  const state = {
    movies: [],
    route: 'home',
    genre: null,
    query: '',
    filter: 'unwatched',
    sort: 'title',
    selectedId: null,
    selectedRating: 0,
    metadata: new Map(),
    recommendation: null,
    migrated: false,
    libraryVisible: 60
  };

  function toast(message, duration = 2800) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), duration);
  }

  function runtimeMinutes(value) {
    const text = String(value || '');
    const hours = Number((text.match(/(\d+)\s*h/i) || [0, 0])[1]);
    const minutes = Number((text.match(/(\d+)\s*m/i) || [0, 0])[1]);
    return hours * 60 + minutes;
  }

  function formatRuntime(value) {
    if (!value) return '';
    if (/\b(h|m)\b/i.test(String(value))) return String(value);
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || !minutes) return '';
    return Math.floor(minutes / 60) ? Math.floor(minutes / 60) + 'h ' + (minutes % 60 ? minutes % 60 + 'm' : '') : minutes + 'm';
  }

  function normalizeMovie(raw) {
    return {
      id: raw.id || uid(),
      title: String(raw.title || '').trim(),
      normalized_title: raw.normalized_title || CinemaVaultMovieRepository.normalizeTitle(raw.title),
      media_type: raw.media_type === 'tv' ? 'tv' : 'movie',
      year: raw.year == null || raw.year === '' ? null : Number(raw.year),
      genre: raw.genre || '',
      runtime_minutes: raw.runtime_minutes ?? (runtimeMinutes(raw.runtime) || null),
      watched: raw.watched === true || raw.watched === 'true' || raw.watched === 'TRUE',
      watched_on: raw.watched_on || raw.watchedOn || null,
      user_rating: raw.user_rating ?? raw.rating ?? null,
      verdict: raw.verdict || '',
      technical_notes: raw.technical_notes || raw.technical || '',
      shot_link: raw.shot_link || raw.shotLink || '',
      createdAt: raw.createdAt || raw.created_at || new Date().toISOString(),
      updatedAt: raw.updatedAt || raw.updated_at || new Date().toISOString(),
      deletedAt: raw.deletedAt || raw.deleted_at || null
    };
  }

  function genres(movie) {
    return CinemaVaultRecommendationEngine.genresFor(movie);
  }

  function unwatched() {
    return state.movies.filter(movie => !movie.watched && !movie.deletedAt);
  }

  function genreCounts() {
    return CinemaVaultRecommendationEngine.inventory(state.movies);
  }

  async function migrateLegacyData() {
    const flag = await CinemaVaultDB.get(CinemaVaultDB.STORES.SETTINGS, 'pr5-migration-complete');
    if (flag?.value) return;

    let legacy = [];
    try {
      const cached = await window.CinemaVaultCache?.getCachedMovies();
      if (cached?.data && Array.isArray(cached.data)) legacy = cached.data;
    } catch (_) {}

    if (!legacy.length) {
      try {
        const raw = localStorage.getItem('cv3_movies');
        if (raw) legacy = JSON.parse(raw);
      } catch (_) {}
    }

    if (Array.isArray(legacy) && legacy.length) {
      for (const item of legacy) {
        const movie = normalizeMovie(item);
        if (movie.title) await CinemaVaultMovieRepository.upsert(movie);
      }
      state.migrated = true;
      toast('Your existing library was moved into local storage.');
    }

    await CinemaVaultDB.put(CinemaVaultDB.STORES.SETTINGS, {
      key: 'pr5-migration-complete',
      value: true,
      completedAt: new Date().toISOString()
    });
  }

  async function loadMovies() {
    state.movies = await CinemaVaultMovieRepository.list({ includeDeleted: false });
    state.movies.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function metadataFor(movie) {
    if (!movie) return null;
    if (state.metadata.has(movie.id)) return state.metadata.get(movie.id);

    const cached = await CinemaVaultMetadataRepository.get(movie.id);
    if (cached) {
      state.metadata.set(movie.id, cached);
      return cached;
    }

    if (!window.CinemaVaultMetadata) return null;
    const remote = await window.CinemaVaultMetadata.fetchCinemaMetadata(movie.title, movie.year);
    const data = {
      tmdbId: remote.id || null,
      tmdbMediaType: remote.mediaType || movie.media_type,
      poster: remote.poster || null,
      backdrop: remote.backdrop || null,
      overview: remote.overview || '',
      tmdbRating: remote.voteAverage || null,
      trailer: remote.trailerKey || null
    };
    await CinemaVaultMetadataRepository.save(movie.id, data);
    state.metadata.set(movie.id, data);
    return data;
  }

  function posterMarkup(movie, meta, extra = '') {
    const image = meta?.poster
      ? '<img loading="lazy" decoding="async" src="' + esc(meta.poster) + '" alt="' + esc(movie.title) + ' poster">'
      : '<div class="poster-fallback"><span>' + esc(movie.title.slice(0, 2).toUpperCase() || 'CV') + '</span></div>';
    return '<div class="poster-frame ' + extra + '">' + image + '<span class="poster-shade"></span>' + (movie.watched ? '<span class="watched-badge">✓</span>' : '') + '</div>';
  }

  function movieCard(movie, compact = false) {
    const meta = state.metadata.get(movie.id);
    return '<article class="movie-card reveal ' + (compact ? 'compact' : '') + '" data-movie="' + esc(movie.id) + '">' +
      posterMarkup(movie, meta) +
      '<div class="movie-card-copy"><h3>' + esc(movie.title) + '</h3><p>' + esc([movie.year || '—', movie.media_type === 'tv' ? 'Series' : 'Movie'].join(' · ')) + '</p>' +
      (movie.user_rating ? '<span class="card-rating">★ ' + esc(movie.user_rating) + '</span>' : '') +
      '</div></article>';
  }

  function loadCardPoster(card) {
    const movie = state.movies.find(x => x.id === card.dataset.movie);
    if (!movie || card.dataset.posterLoading === '1') return;
    card.dataset.posterLoading = '1';
    metadataFor(movie).then(meta => {
      const frame = $('.poster-frame', card);
      if (!frame || !meta?.poster) return;
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = movie.title + ' poster';
      img.src = meta.poster;
      img.onload = () => {
        frame.replaceChildren(img);
        frame.insertAdjacentHTML('beforeend', '<span class="poster-shade"></span>' + (movie.watched ? '<span class="watched-badge">✓</span>' : ''));
        requestAnimationFrame(() => frame.classList.add('loaded'));
      };
    }).catch(() => {});
  }

  function enrichCards(root = document) {
    const cards = $$('.movie-card[data-movie]', root);
    const observer = 'IntersectionObserver' in window
      ? new IntersectionObserver(entries => entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          loadCardPoster(entry.target);
          observer.unobserve(entry.target);
        }), { rootMargin: '500px 0px' })
      : null;

    cards.forEach(card => {
      const movie = state.movies.find(x => x.id === card.dataset.movie);
      const cached = movie ? state.metadata.get(movie.id) : null;
      if (cached?.poster) {
        const frame = $('.poster-frame', card);
        frame.innerHTML = '<img loading="lazy" decoding="async" src="' + esc(cached.poster) + '" alt="' + esc(movie.title) + ' poster"><span class="poster-shade"></span>' + (movie.watched ? '<span class="watched-badge">✓</span>' : '');
        return;
      }
      if (observer) observer.observe(card);
      else loadCardPoster(card);
    });
  }

  function shell(content) {
    const counts = genreCounts();
    const remaining = unwatched().length;
    return '<div class="app-shell">' +
      '<header class="topbar" id="topbar">' +
        '<button class="brand" data-route="home" aria-label="CinemaVault home"><span class="brand-mark">CV</span><span class="brand-name">CinemaVault</span></button>' +
        '<nav class="main-nav" aria-label="Main navigation">' +
          navItem('home','Home') + navItem('library','Library') + navItem('genres','Genres') + navItem('discover','Discover') + navItem('stats','Stats') +
        '</nav>' +
        '<div class="top-actions"><button class="icon-button" data-action="search" aria-label="Search">⌕</button><button class="add-button" data-route="add">+ <span>Add</span></button><button class="menu-button" data-action="menu" aria-label="Open menu">☰</button></div>' +
      '</header>' +
      '<main id="main-content">' + content + '</main>' +
      '<footer class="footer"><span>Private cinema archive</span><span>' + remaining + ' unwatched</span></footer>' +
      '<div class="mobile-nav">' + navItem('home','⌂') + navItem('library','▦') + navItem('discover','✦') + navItem('genres','◈') + navItem('stats','◌') + '</div>' +
      '<div id="search-layer" class="overlay-layer" hidden></div>' +
      '<div id="detail-layer" class="overlay-layer" hidden></div>' +
    '</div>';
  }

  function navItem(route, label) {
    return '<button class="nav-link ' + (state.route === route ? 'active' : '') + '" data-route="' + route + '">' + esc(label) + '</button>';
  }

  function homePage() {
    const candidate = unwatched()[0] || state.movies[0];
    const meta = candidate ? state.metadata.get(candidate.id) : null;
    const counts = genreCounts().slice(0, 6);
    return '<section class="hero cinematic-enter">' +
      '<div class="hero-backdrop">' + (meta?.backdrop ? '<img src="' + esc(meta.backdrop) + '" alt="" loading="eager">' : '') + '</div>' +
      '<div class="hero-glow"></div><div class="hero-content">' +
      '<p class="eyebrow">YOUR PRIVATE CINEMA</p>' +
      '<h1>Every film you want to remember.<br><em>One place.</em></h1>' +
      '<p class="hero-copy">A living archive for everything you have watched, everything waiting, and whatever CinemaVault discovers next.</p>' +
      '<div class="hero-actions"><button class="primary-button" data-route="discover">✦ Discover something</button><button class="ghost-button" data-route="library">Explore library</button></div>' +
      '<div class="hero-stats"><span><b>' + state.movies.length + '</b> titles</span><span><b>' + unwatched().length + '</b> unwatched</span><span><b>' + state.movies.filter(m => m.watched).length + '</b> watched</span></div>' +
      '</div>' +
      (candidate ? '<button class="hero-film" data-movie="' + esc(candidate.id) + '">' + posterMarkup(candidate, meta, 'hero-poster') + '<span>Continue your archive <b>' + esc(candidate.title) + '</b></span></button>' : '') +
      '</section>' +
      '<section class="section reveal"><div class="section-heading"><div><p class="eyebrow">THE NEXT FILM</p><h2>What should you watch?</h2></div><button class="text-button" data-route="discover">Open discover →</button></div><div id="home-recommendation" class="recommendation-slot"></div></section>' +
      '<section class="section reveal"><div class="section-heading"><div><p class="eyebrow">PENDING WORLD</p><h2>Your largest backlogs</h2></div><button class="text-button" data-route="genres">All genres →</button></div><div class="genre-strip">' + counts.map((g,i) => genreTile(g,i)).join('') + '</div></section>' +
      '<section class="section reveal"><div class="section-heading"><div><p class="eyebrow">RECENTLY ADDED</p><h2>New to the vault</h2></div><button class="text-button" data-route="library">Browse all →</button></div><div class="poster-row">' + state.movies.slice(0, 8).map(m => movieCard(m, true)).join('') + '</div></section>';
  }

  function genreTile(row, index) {
    const colorClass = 'tone-' + (index % 5);
    return '<button class="genre-tile ' + colorClass + ' reveal" data-genre="' + esc(row.genre) + '">' +
      '<span class="genre-number">' + String(row.count).padStart(3,'0') + '</span><span class="genre-name">' + esc(row.genre) + '</span><span class="genre-arrow">↗</span></button>';
  }

  function getLibraryList() {
    let list = state.movies.filter(m => !m.deletedAt);
    if (state.filter === 'watched') list = list.filter(m => m.watched);
    if (state.filter === 'unwatched') list = list.filter(m => !m.watched);
    if (state.query) {
      const q = state.query.toLowerCase();
      list = list.filter(m => [m.title,m.genre,m.year].join(' ').toLowerCase().includes(q));
    }
    list.sort((a,b) => {
      if (state.sort === 'year') return Number(b.year || 0) - Number(a.year || 0);
      if (state.sort === 'rating') return Number(b.user_rating || 0) - Number(a.user_rating || 0);
      if (state.sort === 'genre') return String(a.genre).localeCompare(String(b.genre));
      if (state.sort === 'recent') return String(b.updatedAt).localeCompare(String(a.updatedAt));
      return String(a.title).localeCompare(String(b.title));
    });
    return list;
  }

  function libraryPage() {
    const list = getLibraryList();
    const visible = list.slice(0, state.libraryVisible);
    const hasMore = visible.length < list.length;
    return '<section class="page-head cinematic-enter"><div><p class="eyebrow">THE VAULT</p><h1>Your cinema.</h1><p>' + list.length + ' titles in this view.</p></div><button class="primary-button" data-route="add">+ Add to vault</button></section>' +
      '<section class="library-toolbar"><label class="search-box"><span>⌕</span><input id="library-search" value="' + esc(state.query) + '" placeholder="Search your cinema..." autocomplete="off"></label><div class="filter-group">' +
      ['all','unwatched','watched'].map(f => '<button class="filter-button ' + (state.filter===f?'active':'') + '" data-filter="' + f + '">' + (f==='all'?'All':f[0].toUpperCase()+f.slice(1)) + '</button>').join('') +
      '</div><select id="library-sort" class="select-control"><option value="title"' + (state.sort==='title'?' selected':'') + '>A–Z</option><option value="year"' + (state.sort==='year'?' selected':'') + '>Year</option><option value="rating"' + (state.sort==='rating'?' selected':'') + '>Rating</option><option value="genre"' + (state.sort==='genre'?' selected':'') + '>Genre</option><option value="recent"' + (state.sort==='recent'?' selected':'') + '>Recently changed</option></select></section>' +
      (list.length ? '<section class="library-grid">' + visible.map(movieCard).join('') + '</section>' +
        (hasMore ? '<div class="load-more-wrap"><button class="ghost-button" data-action="load-more">Load more · ' + Math.min(60, list.length-visible.length) + ' next</button><p>Showing ' + visible.length + ' of ' + list.length + '</p></div>' : '<div class="load-more-wrap"><p>Showing all ' + list.length + ' titles</p></div>')
        : '<section class="empty-state"><span>✦</span><h2>No films here.</h2><p>Change the filter or add something new to your vault.</p><button class="primary-button" data-route="add">Add a film</button></section>');
  }

  function genresPage() {
    const rows = genreCounts();
    return '<section class="page-head cinematic-enter"><div><p class="eyebrow">YOUR CINEMA / GENRES</p><h1>Every world has a story.</h1><p>' + rows.length + ' genres across ' + unwatched().length + ' unwatched titles.</p></div></section>' +
      '<section class="genre-matrix">' + rows.map((row,i) => genreTile(row,i)).join('') + '</section>';
  }

  function genreDetailPage(genre) {
    const target = String(genre || '');
    const list = unwatched().filter(m => genres(m).some(g => g.toLowerCase() === target.toLowerCase()));
    const sorted = [...list];
    if (state.sort === 'year') sorted.sort((a,b)=>Number(b.year||0)-Number(a.year||0));
    else if (state.sort === 'rating') sorted.sort((a,b)=>Number(b.user_rating||0)-Number(a.user_rating||0));
    else sorted.sort((a,b)=>String(a.title).localeCompare(String(b.title)));
    return '<section class="genre-hero cinematic-enter tone-' + (Math.abs(hashCode(target)) % 5) + '">' +
      '<div><p class="eyebrow">GENRE</p><h1>' + esc(target) + '</h1><p>' + list.length + ' unwatched titles.</p><button class="primary-button" data-action="genre-random">🎲 Random pick</button></div>' +
      '<div class="genre-orbit"><span>' + String(list.length).padStart(3,'0') + '</span><small>waiting to be watched</small></div>' +
      '</section>' +
      '<section class="library-toolbar compact-toolbar"><div class="filter-note">Random here means random <b>inside ' + esc(target) + '</b>.</div><select id="genre-sort" class="select-control"><option value="title">A–Z</option><option value="year">Year</option><option value="rating">Rating</option></select></section>' +
      (sorted.length ? '<section class="library-grid">' + sorted.map(movieCard).join('') + '</section>' : '<section class="empty-state"><span>✓</span><h2>Genre complete.</h2><p>Nothing unwatched remains in ' + esc(target) + '.</p></section>');
  }

  function discoverPage() {
    return '<section class="discover-page cinematic-enter"><div class="discover-intro"><p class="eyebrow">DISCOVER</p><h1>Let the vault decide.</h1><p>The larger a genre backlog is, the more opportunity it receives. Recent genres are gently cooled down so the system stays varied. The final movie is still random.</p></div><div id="discover-recommendation" class="discover-card"></div><div class="discover-history"><div class="section-heading"><div><p class="eyebrow">RECENT PICKS</p><h2>Where the randomness went</h2></div></div><div id="history-list"></div></div></section>';
  }

  function statsPage() {
    const total = state.movies.length;
    const watched = state.movies.filter(m=>m.watched).length;
    const remaining = total - watched;
    const rated = state.movies.filter(m=>m.user_rating != null);
    const avg = rated.length ? (rated.reduce((s,m)=>s+Number(m.user_rating),0)/rated.length).toFixed(1) : '—';
    const rows = genreCounts();
    const max = rows[0]?.count || 1;
    return '<section class="page-head cinematic-enter"><div><p class="eyebrow">YOUR CINEMA JOURNEY</p><h1>The archive, in motion.</h1><p>Progress changes as you watch. Nothing here is static.</p></div></section>' +
      '<section class="stat-story"><div class="story-number"><span>' + total + '</span><small>total titles</small></div><div class="story-number"><span>' + watched + '</span><small>watched</small></div><div class="story-number"><span>' + remaining + '</span><small>remaining</small></div><div class="story-number"><span>' + avg + '</span><small>average rating</small></div></section>' +
      '<section class="section"><div class="section-heading"><div><p class="eyebrow">PROGRESS</p><h2>Watching the vault disappear.</h2></div></div><div class="progress-scene"><div class="progress-ring" style="--progress:' + (total ? Math.round(watched/total*100) : 0) + '%"><span>' + (total ? Math.round(watched/total*100) : 0) + '%</span></div><div><p>Every watched title leaves the recommendation pool and reduces every genre it belongs to.</p><div class="long-progress"><span style="width:' + (total ? watched/total*100 : 0) + '%"></span></div></div></div></section>' +
      '<section class="section"><div class="section-heading"><div><p class="eyebrow">GENRE BALANCE</p><h2>What is still waiting?</h2></div></div><div class="animated-bars">' + rows.slice(0,10).map((r,i)=>'<button class="stat-bar" data-genre="' + esc(r.genre) + '"><span><b>' + esc(r.genre) + '</b><small>' + r.count + ' unwatched</small></span><i><em style="width:' + Math.max(4,Math.round(r.count/max*100)) + '%"></em></i></button>').join('') + '</div></section>';
  }

  function addPage() {
    return '<section class="page-head cinematic-enter"><div><p class="eyebrow">ADD TO VAULT</p><h1>Bring something into the archive.</h1><p>Everything starts locally. Metadata can be resolved later.</p></div></section>' +
      '<section class="add-layout"><div class="add-panel"><div class="panel-heading"><span>01</span><h2>Single title</h2></div><form id="single-form" class="form-stack"><label>Title<input id="add-title" required placeholder="e.g. Blade Runner 2049"></label><div class="two-fields"><label>Year<input id="add-year" inputmode="numeric" placeholder="2017"></label><label>Type<select id="add-type"><option value="movie">Movie</option><option value="tv">Series</option></select></label></div><label>Genres<input id="add-genre" placeholder="Sci-Fi, Thriller"></label><label>Runtime<input id="add-runtime" placeholder="2h 44m"></label><button class="primary-button" type="submit">Add to vault</button></form></div>' +
      '<div class="add-panel"><div class="panel-heading"><span>02</span><h2>Bulk titles</h2></div><textarea id="bulk-input" rows="12" placeholder="Paste one title per line. You can include year and genre information."></textarea><div class="panel-actions"><button class="ghost-button" data-action="parse-bulk">Parse locally</button><span id="bulk-status"></span></div><div id="bulk-preview"></div></div></section>';
  }

  function settingsPage() {
    return '<section class="page-head cinematic-enter"><div><p class="eyebrow">SETTINGS</p><h1>Keep the vault yours.</h1><p>PR5 is local-first. Supabase sync arrives in the next integration phase.</p></div></section>' +
      '<section class="settings-grid"><div class="settings-panel"><span class="settings-icon">◉</span><h2>Local storage</h2><p>Your current library lives in IndexedDB on this browser. Changes are recorded locally before any future remote synchronization.</p><span class="status-pill local">Local-first</span></div><div class="settings-panel"><span class="settings-icon">↗</span><h2>Sync queue</h2><p id="queue-status">Checking pending changes…</p><span class="status-pill pending">Ready for sync engine</span></div><div class="settings-panel"><span class="settings-icon">◎</span><h2>TMDB metadata</h2><p>Posters, backdrops and metadata are fetched only when needed and cached locally.</p><label class="inline-field">TMDB API key<input id="tmdb-key" type="password" placeholder="Stored only in this browser"></label><button class="ghost-button" data-action="save-key">Save key</button></div><div class="settings-panel danger-panel"><span class="settings-icon">⌫</span><h2>Clear local library</h2><p>This removes the CinemaVault local database from this browser.</p><button class="danger-button" data-action="clear-all">Clear local data</button></div></section>';
  }

  function render() {
    let content = '';
    if (state.route === 'home') content = homePage();
    else if (state.route === 'library') content = libraryPage();
    else if (state.route === 'genres') content = state.genre ? genreDetailPage(state.genre) : genresPage();
    else if (state.route === 'discover') content = discoverPage();
    else if (state.route === 'stats') content = statsPage();
    else if (state.route === 'add') content = addPage();
    else if (state.route === 'settings') content = settingsPage();
    $('#app').innerHTML = shell(content);
    bind();
    reveal();
    if (state.route === 'home') renderHomeRecommendation();
    if (state.route === 'discover') { renderDiscoverRecommendation(); renderHistory(); }
    if (state.route === 'settings') updateQueueStatus();
    enrichCards();
    preloadHero();
  }

  async function preloadHero() {
    const candidate = unwatched()[0] || state.movies[0];
    if (candidate) {
      const meta = await metadataFor(candidate);
      if (state.route !== 'home') return;
      const backdrop = $('.hero-backdrop');
      if (backdrop && meta?.backdrop) backdrop.innerHTML = '<img src="' + esc(meta.backdrop) + '" alt="" loading="eager">';
    }
  }

  async function renderHomeRecommendation() {
    const slot = $('#home-recommendation');
    if (!slot) return;
    slot.innerHTML = '<div class="recommendation-loading"><span></span><p>Drawing from your vault…</p></div>';
    const result = await CinemaVaultRecommendationEngine.globalRecommendation(state.movies);
    if (!result) {
      slot.innerHTML = '<div class="empty-recommendation"><h3>Your unwatched library is complete.</h3><p>Every title has been watched. Add something new to start the cycle again.</p></div>';
      return;
    }
    state.recommendation = result;
    slot.innerHTML = recommendationMarkup(result);
    await enrichRecommendation(slot, result.movie);
  }

  async function renderDiscoverRecommendation(force = false) {
    const slot = $('#discover-recommendation');
    if (!slot) return;
    if (!force && state.recommendation) {
      slot.innerHTML = recommendationMarkup(state.recommendation);
      await enrichRecommendation(slot, state.recommendation.movie);
      return;
    }
    slot.innerHTML = '<div class="recommendation-loading"><span></span><p>Finding a balanced random pick…</p></div>';
    const result = await CinemaVaultRecommendationEngine.globalRecommendation(state.movies);
    state.recommendation = result;
    if (!result) {
      slot.innerHTML = '<div class="empty-recommendation"><h3>The vault is complete.</h3><p>No unwatched titles remain.</p></div>';
      return;
    }
    slot.innerHTML = recommendationMarkup(result);
    await enrichRecommendation(slot, result.movie);
  }

  function recommendationMarkup(result) {
    const movie = result.movie;
    const meta = state.metadata.get(movie.id);
    return '<article class="recommendation-card" data-recommendation="' + esc(movie.id) + '">' +
      '<div class="recommendation-art">' + posterMarkup(movie, meta, 'recommendation-poster') + '</div>' +
      '<div class="recommendation-copy"><p class="eyebrow">RANDOM PICK</p><h2>' + esc(movie.title) + '</h2><p class="recommendation-meta">' + esc([movie.year || '—', movie.media_type === 'tv' ? 'Series' : 'Movie', genres(movie).join(' · ')].join(' · ')) + '</p>' +
      '<p class="recommendation-reason">' + esc(result.reason || 'Randomly selected from your unwatched library.') + '</p>' +
      '<div class="recommendation-actions"><button class="primary-button" data-action="watch-now">Open film</button><button class="ghost-button" data-action="skip-recommendation">Skip</button><button class="icon-button large" data-action="shuffle">↻</button></div></div></article>';
  }

  async function enrichRecommendation(root, movie) {
    const meta = await metadataFor(movie);
    const frame = $('.recommendation-poster', root);
    if (frame && meta?.poster) frame.innerHTML = '<img loading="eager" decoding="async" src="' + esc(meta.poster) + '" alt="' + esc(movie.title) + ' poster"><span class="poster-shade"></span>';
  }

  async function renderHistory() {
    const target = $('#history-list');
    if (!target) return;
    const history = await CinemaVaultRecommendationHistory.recent(8);
    if (!history.length) {
      target.innerHTML = '<p class="muted">No recommendations yet.</p>';
      return;
    }
    target.innerHTML = history.map(item => {
      const movie = state.movies.find(m=>m.id===item.movieId);
      return '<button class="history-item" data-movie="' + esc(item.movieId) + '"><span>' + esc(movie?.title || 'Removed title') + '</span><small>' + esc(item.result) + ' · ' + new Date(item.at).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) + '</small></button>';
    }).join('');
  }

  async function openMovie(id) {
    const movie = state.movies.find(m=>m.id===id);
    if (!movie) return;
    state.selectedId = id;
    state.selectedRating = Number(movie.user_rating || 0);
    const layer = $('#detail-layer');
    layer.hidden = false;
    layer.innerHTML = '<div class="detail-backdrop"></div><div class="detail-panel"><button class="close-button" data-action="close-detail">×</button><div class="detail-loading"><span></span><p>Opening your record…</p></div></div>';
    document.body.classList.add('modal-open');
    const meta = await metadataFor(movie);
    if (state.selectedId !== id) return;
    layer.innerHTML = detailMarkup(movie, meta);
    bindDetail(layer);
  }

  function detailMarkup(movie, meta) {
    const rating = Number(movie.user_rating || 0);
    return '<div class="detail-backdrop" style="' + (meta?.backdrop ? 'background-image:linear-gradient(90deg,rgba(7,8,10,.98) 0%,rgba(7,8,10,.82) 45%,rgba(7,8,10,.48) 100%),url(' + esc(meta.backdrop) + ')' : '') + '"></div>' +
      '<div class="detail-panel"><button class="close-button" data-action="close-detail">×</button><div class="detail-hero"><div class="detail-poster">' + posterMarkup(movie, meta) + '</div><div class="detail-copy"><p class="eyebrow">FILM RECORD</p><h1>' + esc(movie.title) + '</h1><p class="detail-meta">' + esc([movie.year || '—', movie.media_type === 'tv' ? 'Series' : 'Movie', formatRuntime(movie.runtime_minutes)].filter(Boolean).join(' · ')) + '</p><div class="detail-genres">' + genres(movie).map(g=>'<span>'+esc(g)+'</span>').join('') + '</div>' + (meta?.overview ? '<p class="overview">' + esc(meta.overview) + '</p>' : '') + (meta?.trailer ? '<button class="ghost-button" data-action="trailer">Watch trailer ↗</button>' : '') + '</div></div>' +
      '<div class="record-section"><p class="eyebrow">YOUR RECORD</p><h2>How did it feel?</h2><div class="rating-row">' + [1,2,3,4,5].map(n=>'<button class="rating-choice ' + (rating===n?'active':'') + '" data-rating="'+n+'" aria-label="Rating '+n+'">' + ['😐','🙂','👍','🔥','💯'][n-1] + '</button>').join('') + '</div><div class="watch-line"><label><input id="detail-watched" type="checkbox" ' + (movie.watched?'checked':'') + '> <span>Mark as watched</span></label><label>Watched on<input id="detail-date" type="date" value="' + esc(movie.watched_on || '') + '"></label></div><div class="record-grid"><label>Verdict<textarea id="detail-verdict" rows="3" placeholder="Your take…">' + esc(movie.verdict) + '</textarea></label><label>Technical notes<textarea id="detail-technical" rows="3" placeholder="VFX, cinematography, sound, editing…">' + esc(movie.technical_notes) + '</textarea></label></div><div class="detail-actions"><button class="primary-button" data-action="save-detail">Save record</button><button class="danger-button" data-action="delete-detail">Remove from vault</button></div></div></div>';
  }

  function bindDetail(layer) {
    $('[data-action="close-detail"]', layer)?.addEventListener('click', closeDetail);
    layer.addEventListener('click', e => { if (e.target === layer) closeDetail(); });
    $$('[data-rating]', layer).forEach(btn => btn.addEventListener('click', () => {
      state.selectedRating = Number(btn.dataset.rating);
      $$('[data-rating]', layer).forEach(x=>x.classList.toggle('active', x === btn));
    }));
    $('[data-action="save-detail"]', layer)?.addEventListener('click', saveDetail);
    $('[data-action="delete-detail"]', layer)?.addEventListener('click', deleteDetail);
    $('[data-action="trailer"]', layer)?.addEventListener('click', () => {
      const movie = state.movies.find(m=>m.id===state.selectedId);
      const meta = state.metadata.get(movie?.id);
      if (meta?.trailer) window.open('https://www.youtube.com/watch?v=' + encodeURIComponent(meta.trailer), '_blank', 'noopener,noreferrer');
    });
  }

  async function saveDetail() {
    const movie = state.movies.find(m=>m.id===state.selectedId);
    if (!movie) return;
    const watched = $('#detail-watched').checked;
    const updated = {
      ...movie,
      watched,
      watched_on: watched ? ($('#detail-date').value || new Date().toISOString().slice(0,10)) : null,
      user_rating: state.selectedRating || null,
      verdict: $('#detail-verdict').value.trim(),
      technical_notes: $('#detail-technical').value.trim(),
      updatedAt: new Date().toISOString()
    };
    const saved = await CinemaVaultLocalFirstRepository.saveMovie(updated);
    state.movies = state.movies.map(m => m.id === saved.id ? saved : m);
    if (watched) await CinemaVaultRecommendationEngine.recordResult(saved, 'watched');
    closeDetail();
    render();
    toast(watched ? '✓ Watched — your backlog just changed.' : '✓ Record saved locally.');
  }

  async function deleteDetail() {
    const movie = state.movies.find(m=>m.id===state.selectedId);
    if (!movie || !confirm('Remove "' + movie.title + '" from your local vault?')) return;
    await CinemaVaultLocalFirstRepository.deleteMovie(movie.id);
    state.movies = state.movies.filter(m=>m.id !== movie.id);
    closeDetail();
    render();
    toast('Removed from your local vault.');
  }

  function closeDetail() {
    state.selectedId = null;
    $('#detail-layer').hidden = true;
    $('#detail-layer').innerHTML = '';
    document.body.classList.remove('modal-open');
  }

  async function addSingle() {
    const title = $('#add-title').value.trim();
    if (!title) return;
    const existing = await CinemaVaultMovieRepository.findDuplicate({title, media_type:$('#add-type').value, year:$('#add-year').value});
    if (existing) { toast('That title is already in the vault.'); return; }
    const movie = await CinemaVaultLocalFirstRepository.saveMovie({
      id: uid(),
      title,
      year: $('#add-year').value || null,
      media_type: $('#add-type').value,
      genre: $('#add-genre').value.trim(),
      runtime_minutes: runtimeMinutes($('#add-runtime').value) || null,
      watched: false
    });
    state.movies.unshift(movie);
    toast('✓ Added to your vault.');
    state.route = 'library';
    state.filter = 'unwatched';
    render();
  }

  function parseBulkText(text) {
    return text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{
      const parts = line.split(/\s+[|—–-]\s+/);
      const title = (parts[0] || line).trim();
      const yearMatch = line.match(/\b(18\d{2}|19\d{2}|20\d{2}|21\d{2})\b/);
      return {
        id: uid(),
        title: title.replace(/\s*\((Series|Show|TV)\)\s*/i,'').trim(),
        year: yearMatch ? Number(yearMatch[1]) : null,
        media_type: /\b(series|show|tv)\b/i.test(line) ? 'tv' : 'movie',
        genre: parts[1] && !/^\d{4}$/.test(parts[1]) ? parts[1].trim() : '',
        watched: false
      };
    });
  }

  async function parseBulk() {
    const raw = $('#bulk-input').value.trim();
    if (!raw) return toast('Paste some titles first.');
    const parsed = parseBulkText(raw);
    const fresh = [];
    for (const item of parsed) {
      const duplicate = await CinemaVaultMovieRepository.findDuplicate(item);
      if (!duplicate) fresh.push(item);
    }
    $('#bulk-status').textContent = fresh.length + ' new of ' + parsed.length + ' parsed.';
    $('#bulk-preview').innerHTML = fresh.slice(0,20).map(m=>'<div class="preview-row"><b>'+esc(m.title)+'</b><span>'+esc([m.year,m.genre,m.media_type].filter(Boolean).join(' · '))+'</span></div>').join('') + (fresh.length>20?'<p class="muted">+'+(fresh.length-20)+' more</p>':'');
    $('#bulk-preview').dataset.items = JSON.stringify(fresh);
    if (fresh.length) $('#bulk-preview').insertAdjacentHTML('beforeend','<button class="primary-button" data-action="add-parsed">Add '+fresh.length+' titles</button>');
  }

  async function addParsed() {
    let items = [];
    try { items = JSON.parse($('#bulk-preview').dataset.items || '[]'); } catch (_) {}
    if (!items.length) return;
    for (const item of items) await CinemaVaultLocalFirstRepository.saveMovie(item);
    await loadMovies();
    toast('✓ ' + items.length + ' titles added.');
    state.route='library';
    render();
  }

  async function genreRandom() {
    const result = await CinemaVaultRecommendationEngine.genreRecommendation(state.movies, state.genre);
    if (!result) return toast('No unwatched title remains in this genre.');
    await openMovie(result.movie.id);
  }

  async function updateQueueStatus() {
    const pending = await CinemaVaultSyncQueue.list('pending');
    const failed = await CinemaVaultSyncQueue.list('failed');
    const el = $('#queue-status');
    if (el) el.textContent = pending.length + ' pending local change' + (pending.length===1?'':'s') + (failed.length ? ' · ' + failed.length + ' failed waiting for retry' : '') + '.';
  }

  function saveKey() {
    const value = $('#tmdb-key')?.value.trim() || '';
    if (value) localStorage.setItem('cv3_tmdb_key', value);
    else localStorage.removeItem('cv3_tmdb_key');
    state.metadata.clear();
    toast('TMDB key saved locally.');
  }

  async function clearAll() {
    if (!confirm('Clear CinemaVault data from this browser? This cannot be undone.')) return;
    await CinemaVaultDB.clearAll();
    state.movies = [];
    state.metadata.clear();
    state.recommendation = null;
    state.route='home';
    render();
    toast('Local vault cleared.');
  }

  function openSearch() {
    const layer = $('#search-layer');
    layer.hidden = false;
    layer.innerHTML = '<div class="search-modal"><button class="close-button" data-action="close-search">×</button><p class="eyebrow">SEARCH YOUR CINEMA</p><input id="global-search" autofocus placeholder="Title, year, genre…"><div id="search-results"></div><small>Press Escape to close</small></div>';
    const input = $('#global-search');
    input.addEventListener('input', () => renderSearchResults(input.value));
    input.addEventListener('keydown', e => { if(e.key==='Escape') closeSearch(); });
    renderSearchResults('');
  }

  function renderSearchResults(query) {
    const target = $('#search-results');
    const q = query.trim().toLowerCase();
    const rows = state.movies.filter(m => !q || [m.title,m.genre,m.year,m.verdict,m.technical_notes].join(' ').toLowerCase().includes(q)).slice(0,12);
    target.innerHTML = rows.map(m=>'<button class="search-result" data-movie="'+esc(m.id)+'"><span>'+esc(m.title)+'</span><small>'+esc([m.year,m.genre,m.watched?'Watched':'Unwatched'].filter(Boolean).join(' · '))+'</small></button>').join('') || '<p class="muted">No matches.</p>';
    $$('.search-result', target).forEach(x=>x.addEventListener('click',()=>{closeSearch();openMovie(x.dataset.movie);}));
  }

  function closeSearch() {
    $('#search-layer').hidden = true;
    $('#search-layer').innerHTML='';
  }

  function route(route) {
    state.route = route;
    if (route !== 'genres') state.genre = null;
    window.scrollTo({top:0, behavior:'smooth'});
    render();
  }

  function reveal() {
    requestAnimationFrame(() => $$('.reveal').forEach((el,i)=>setTimeout(()=>el.classList.add('visible'), Math.min(i*28,260))));
  }

  function hashCode(value) {
    let hash=0;
    for(let i=0;i<value.length;i++) hash=((hash<<5)-hash)+value.charCodeAt(i)|0;
    return hash;
  }

  function bind() {
    $$('[data-route]').forEach(el=>el.addEventListener('click',()=>route(el.dataset.route)));
    $$('[data-movie]').forEach(el=>el.addEventListener('click',()=>openMovie(el.dataset.movie)));
    $$('[data-genre]').forEach(el=>el.addEventListener('click',()=>{state.genre=el.dataset.genre;state.route='genres';render();}));
    $$('[data-filter]').forEach(el=>el.addEventListener('click',()=>{state.filter=el.dataset.filter;state.libraryVisible=60;render();}));
    $('#library-sort')?.addEventListener('change',e=>{state.sort=e.target.value;state.libraryVisible=60;render();});
    $('#library-search')?.addEventListener('input',e=>{state.query=e.target.value;state.libraryVisible=60;clearTimeout(state._searchTimer);state._searchTimer=setTimeout(render,180);});
    $$('[data-action="load-more"]').forEach(el=>el.addEventListener('click',()=>{state.libraryVisible+=60;render();}));
    $('#genre-sort')?.addEventListener('change',e=>{state.sort=e.target.value;render();});
    $('#single-form')?.addEventListener('submit',e=>{e.preventDefault();addSingle();});
    $$('[data-action="parse-bulk"]').forEach(el=>el.addEventListener('click',parseBulk));
    $$('[data-action="add-parsed"]').forEach(el=>el.addEventListener('click',addParsed));
    $$('[data-action="genre-random"]').forEach(el=>el.addEventListener('click',genreRandom));
    $$('[data-action="search"]').forEach(el=>el.addEventListener('click',openSearch));
    $$('[data-action="close-search"]').forEach(el=>el.addEventListener('click',closeSearch));
    $$('[data-action="save-key"]').forEach(el=>el.addEventListener('click',saveKey));
    $$('[data-action="clear-all"]').forEach(el=>el.addEventListener('click',clearAll));
    $$('[data-action="watch-now"]').forEach(el=>el.addEventListener('click',()=>openMovie(state.recommendation?.movie.id)));
    $$('[data-action="skip-recommendation"]').forEach(el=>el.addEventListener('click',async()=>{if(state.recommendation){await CinemaVaultRecommendationEngine.recordResult(state.recommendation.movie,'skipped');toast('Skipped for now.');} if(state.route==='home')renderHomeRecommendation(); else renderDiscoverRecommendation(true);}));
    $$('[data-action="shuffle"]').forEach(el=>el.addEventListener('click',async()=>{state.recommendation=null; if(state.route==='home')renderHomeRecommendation(); else renderDiscoverRecommendation(true);}));
    $$('[data-action="menu"]').forEach(el=>el.addEventListener('click',()=>route('settings')));
    $$('[data-action="trailer"]').forEach(el=>el.addEventListener('click',()=>{}));
    $$('[data-genre]').forEach(el=>el.addEventListener('keydown',e=>{if(e.key==='Enter')el.click();}));
  }

  async function boot() {
    await migrateLegacyData();
    await CinemaVaultSyncQueue.resetProcessing();
    await loadMovies();
    render();
    window.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openSearch();} if(e.key==='Escape'){closeSearch();if(!$('#detail-layer').hidden)closeDetail();}});
    window.addEventListener('scroll',()=>document.body.classList.toggle('scrolled',window.scrollY>28),{passive:true});
  }

  boot().catch(error=>{
    console.error('[CinemaVault boot]', error);
    const app = $('#app');
    if (app) {
      app.innerHTML='<main class="fatal"><p class="eyebrow">CINEMAVAULT STARTUP ERROR</p><h1>CinemaVault could not open.</h1><p>'+esc(error?.message || String(error))+'</p><button class="primary-button" onclick="location.reload()">Reload</button></main>';
    }
  });
})();
