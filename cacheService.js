(function () {
  const DB_NAME = 'CinemaVaultDB';
  const STORE_NAME = 'movie_cache';
  const CACHE_KEY = 'master_list';
  let dbPromise;

  function openDB() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB unavailable'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function () {
        request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
    return dbPromise;
  }

  function getCachedMovies() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(CACHE_KEY);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { reject(request.error); };
      });
    });
  }

  function setCachedMovies(data) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put({ timestamp: Date.now(), data: data }, CACHE_KEY);
        transaction.oncomplete = resolve;
        transaction.onerror = function () { reject(transaction.error); };
      });
    });
  }

  window.CinemaVaultCache = {
    getCachedMovies: getCachedMovies,
    setCachedMovies: setCachedMovies
  };
}());
