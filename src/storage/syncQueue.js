/* Durable local-first mutation queue.
 * The queue records intent; the future sync engine will execute it against Supabase.
 */
(function (global) {
  'use strict';

  const DB = () => global.CinemaVaultDB;
  const now = () => new Date().toISOString();

  const STATUS = Object.freeze({
    PENDING: 'pending',
    PROCESSING: 'processing',
    FAILED: 'failed'
  });

  async function enqueue({ operation, entity, entityId, payload }) {
    if (!['create', 'update', 'delete'].includes(operation)) throw new Error('Unsupported sync operation');
    if (!entity) throw new Error('Sync entity is required');
    if (!entityId) throw new Error('Sync entityId is required');

    const record = {
      operation,
      entity,
      entityId,
      payload: payload ?? null,
      status: STATUS.PENDING,
      retryCount: 0,
      lastError: null,
      createdAt: now(),
      updatedAt: now()
    };

    const db = await DB().open();
    try {
      const tx = db.transaction(DB().STORES.PENDING, 'readwrite');
      const request = tx.objectStore(DB().STORES.PENDING).add(record);
      const id = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return { ...record, id };
    } finally {
      db.close();
    }
  }

  async function list(status = STATUS.PENDING) {
    const rows = await DB().getAll(DB().STORES.PENDING);
    return rows
      .filter((row) => row.status === status)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  async function get(id) {
    return DB().get(DB().STORES.PENDING, id);
  }

  async function update(id, patch) {
    const existing = await get(id);
    if (!existing) throw new Error('Sync queue item not found: ' + id);
    return DB().put(DB().STORES.PENDING, {
      ...existing,
      ...patch,
      id,
      updatedAt: now()
    });
  }

  async function acknowledge(id) {
    return DB().remove(DB().STORES.PENDING, id);
  }

  async function markFailed(id, error) {
    const existing = await get(id);
    if (!existing) return null;
    return update(id, {
      status: STATUS.FAILED,
      retryCount: Number(existing.retryCount || 0) + 1,
      lastError: String(error?.message || error || 'Unknown sync error')
    });
  }

  async function retry(id) {
    return update(id, {
      status: STATUS.PENDING,
      lastError: null
    });
  }

  async function resetProcessing() {
    const rows = await list(STATUS.PROCESSING);
    for (const row of rows) await update(row.id, { status: STATUS.PENDING });
    return rows.length;
  }

  return global.CinemaVaultSyncQueue = Object.freeze({
    STATUS,
    enqueue,
    list,
    get,
    update,
    acknowledge,
    markFailed,
    retry,
    resetProcessing
  });
})(window);
