/* CinemaVault local-first storage foundation.
 * PR4 only: no UI integration and no Supabase client dependency.
 */
(function (global) {
  'use strict';

  const DB_NAME = 'cinemavault';
  const DB_VERSION = 1;

  const STORES = Object.freeze({
    MOVIES: 'movies',
    METADATA: 'metadata',
    PENDING: 'pending_operations',
    SETTINGS: 'settings',
    SYNC: 'sync_state'
  });

  const openRequest = (upgrade) => new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      upgrade(db, event.oldVersion, event.newVersion, request.transaction);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open CinemaVault IndexedDB'));
    request.onblocked = () => reject(new Error('CinemaVault IndexedDB upgrade is blocked by another open connection'));
  });

  function ensureStore(db, transaction, name, options) {
    return db.objectStoreNames.contains(name)
      ? transaction.objectStore(name)
      : db.createObjectStore(name, options);
  }

  function createSchema(db, oldVersion, newVersion, transaction) {
    const movies = ensureStore(db, transaction, STORES.MOVIES, { keyPath: 'id' });
    if (!movies.indexNames.contains('normalized_title')) movies.createIndex('normalized_title', 'normalized_title', { unique: false });
    if (!movies.indexNames.contains('updatedAt')) movies.createIndex('updatedAt', 'updatedAt', { unique: false });
    if (!movies.indexNames.contains('media_type')) movies.createIndex('media_type', 'media_type', { unique: false });
    if (!movies.indexNames.contains('watched')) movies.createIndex('watched', 'watched', { unique: false });

    const metadata = ensureStore(db, transaction, STORES.METADATA, { keyPath: 'movieId' });
    if (!metadata.indexNames.contains('tmdbId')) metadata.createIndex('tmdbId', 'tmdbId', { unique: false });
    if (!metadata.indexNames.contains('cachedAt')) metadata.createIndex('cachedAt', 'cachedAt', { unique: false });

    const pending = ensureStore(db, transaction, STORES.PENDING, { keyPath: 'id', autoIncrement: true });
    if (!pending.indexNames.contains('status')) pending.createIndex('status', 'status', { unique: false });
    if (!pending.indexNames.contains('createdAt')) pending.createIndex('createdAt', 'createdAt', { unique: false });
    if (!pending.indexNames.contains('entity')) pending.createIndex('entity', 'entity', { unique: false });
    if (!pending.indexNames.contains('entityId')) pending.createIndex('entityId', 'entityId', { unique: false });

    ensureStore(db, transaction, STORES.SETTINGS, { keyPath: 'key' });
    ensureStore(db, transaction, STORES.SYNC, { keyPath: 'id' });
  }

  async function open() {
    return openRequest(createSchema);
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
  }

  async function get(storeName, key) {
    const db = await open();
    try {
      return await requestResult(db.transaction(storeName, 'readonly').objectStore(storeName).get(key));
    } finally {
      db.close();
    }
  }

  async function getAll(storeName) {
    const db = await open();
    try {
      return await requestResult(db.transaction(storeName, 'readonly').objectStore(storeName).getAll());
    } finally {
      db.close();
    }
  }

  async function put(storeName, value) {
    const db = await open();
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      await transactionDone(tx);
      return value;
    } finally {
      db.close();
    }
  }

  async function remove(storeName, key) {
    const db = await open();
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      await transactionDone(tx);
    } finally {
      db.close();
    }
  }

  async function clearStore(storeName) {
    const db = await open();
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      await transactionDone(tx);
    } finally {
      db.close();
    }
  }

  async function clearAll() {
    const db = await open();
    try {
      const tx = db.transaction(Object.values(STORES), 'readwrite');
      Object.values(STORES).forEach((name) => tx.objectStore(name).clear());
      await transactionDone(tx);
    } finally {
      db.close();
    }
  }

  global.CinemaVaultDB = Object.freeze({
    DB_NAME,
    DB_VERSION,
    STORES,
    open,
    get,
    getAll,
    put,
    remove,
    clearStore,
    clearAll
  });
})(window);
