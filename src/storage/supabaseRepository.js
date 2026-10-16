/* Authenticated Supabase persistence for CinemaVault's local-first UI. */
(function (global) {
  'use strict';

  const client = () => {
    if (!global.CinemaVaultSupabaseClient) {
      throw new Error('Supabase client is not configured. Reload the page and try again.');
    }
    return global.CinemaVaultSupabaseClient;
  };
  const DB = () => global.CinemaVaultDB;
  const Queue = () => global.CinemaVaultSyncQueue;
  const PAGE_SIZE = 1000;
  const MOVIE_COLUMNS = [
    'id', 'owner_id', 'title', 'normalized_title', 'media_type', 'year', 'genre',
    'runtime_minutes', 'watched', 'watched_on', 'user_rating', 'verdict',
    'technical_notes', 'shot_link', 'created_at', 'updated_at', 'deleted_at'
  ].join(',');

  async function getSession() {
    const { data, error } = await client().auth.getSession();
    if (error) throw error;
    return data.session || null;
  }

  async function signInWithPassword(email, password) {
    const { data, error } = await client().auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw error;
    return data.session;
  }

  async function sendMagicLink(email) {
    const { error } = await client().auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: false,
        emailRedirectTo: window.location.origin
      }
    });
    if (error) throw error;
  }

  async function signOut() {
    const { error } = await client().auth.signOut();
    if (error) throw error;
  }

  function toLocal(row) {
    return {
      id: row.id,
      title: row.title,
      normalized_title: row.normalized_title,
      media_type: row.media_type === 'tv' ? 'tv' : 'movie',
      year: row.year == null ? null : Number(row.year),
      genre: row.genre || '',
      runtime_minutes: row.runtime_minutes == null ? null : Number(row.runtime_minutes),
      watched: row.watched === true,
      watched_on: row.watched_on || null,
      user_rating: row.user_rating == null ? null : Number(row.user_rating),
      verdict: row.verdict || '',
      technical_notes: row.technical_notes || '',
      shot_link: row.shot_link || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at || null
    };
  }

  function toRemote(input, userId) {
    return {
      id: input.id,
      owner_id: userId,
      title: String(input.title || '').trim(),
      normalized_title: input.normalized_title || global.CinemaVaultMovieRepository.normalizeTitle(input.title),
      media_type: input.media_type === 'tv' ? 'tv' : 'movie',
      year: input.year == null || input.year === '' ? null : Number(input.year),
      genre: input.genre || null,
      runtime_minutes: input.runtime_minutes == null || input.runtime_minutes === '' ? null : Number(input.runtime_minutes),
      watched: input.watched === true,
      watched_on: input.watched_on || null,
      user_rating: input.user_rating == null || input.user_rating === '' ? null : Number(input.user_rating),
      verdict: input.verdict || null,
      technical_notes: input.technical_notes || null,
      shot_link: input.shot_link || null,
      created_at: input.createdAt || input.created_at || new Date().toISOString(),
      updated_at: input.updatedAt || input.updated_at || new Date().toISOString(),
      deleted_at: input.deletedAt || input.deleted_at || null
    };
  }

  async function fetchAllMovies() {
    const session = await getSession();
    if (!session?.user?.id) throw new Error('Please sign in to load your CinemaVault library.');

    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const to = from + PAGE_SIZE - 1;
      const { data, error } = await client()
        .from('movies')
        .select(MOVIE_COLUMNS)
        .eq('owner_id', session.user.id)
        .order('created_at', { ascending: true })
        .range(from, to);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < PAGE_SIZE) break;
    }
    return { rows, userId: session.user.id };
  }

  async function hydrateLocal(rows) {
    for (const row of rows) {
      await DB().put(DB().STORES.MOVIES, toLocal(row));
    }
  }

  async function flushQueue() {
    const session = await getSession();
    if (!session?.user?.id) return { synced: 0, pending: true };

    const pending = await Queue().list(Queue().STATUS.PENDING);
    let synced = 0;
    for (const item of pending) {
      try {
        if (item.entity !== 'movie') throw new Error('Unsupported sync entity: ' + item.entity);
        const payload = item.payload || await global.CinemaVaultMovieRepository.get(item.entityId);
        if (!payload) {
          await Queue().acknowledge(item.id);
          continue;
        }
        const remote = toRemote(payload, session.user.id);
        const { error } = await client().from('movies').upsert(remote, { onConflict: 'id' });
        if (error) throw error;
        await Queue().acknowledge(item.id);
        synced += 1;
      } catch (error) {
        await Queue().markFailed(item.id, error);
        console.error('[CinemaVault sync] Mutation failed:', error);
      }
    }
    return { synced, pending: false };
  }

  async function syncMovies() {
    const first = await fetchAllMovies();
    await hydrateLocal(first.rows);

    // Retry mutations that failed in an earlier session. Upserts are keyed by
    // movie id, so retrying is safe and lets previously queued additions recover.
    const failed = await Queue().list(Queue().STATUS.FAILED);
    for (const item of failed) await Queue().retry(item.id);

    await flushQueue();
    const refreshed = await fetchAllMovies();
    await hydrateLocal(refreshed.rows);
    await global.CinemaVaultSyncStateRepository.markSuccess({ cursor: null });
    return { count: refreshed.rows.filter(row => !row.deleted_at).length };
  }

  return global.CinemaVaultSupabaseRepository = Object.freeze({
    getSession,
    signInWithPassword,
    sendMagicLink,
    signOut,
    fetchAllMovies,
    syncMovies,
    flushQueue
  });
})(window);
