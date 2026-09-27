/* Per-device synchronization state. */
(function (global) {
  'use strict';

  const DB = () => global.CinemaVaultDB;
  const DEVICE_KEY = 'device-id';

  async function getDeviceId() {
    const existing = await DB().get(DB().STORES.SETTINGS, DEVICE_KEY);
    if (existing?.value) return existing.value;

    const value = crypto.randomUUID();
    await DB().put(DB().STORES.SETTINGS, { key: DEVICE_KEY, value });
    return value;
  }

  async function get(id = 'default') {
    return DB().get(DB().STORES.SYNC, id);
  }

  async function save(state) {
    const record = {
      id: state.id || 'default',
      deviceId: state.deviceId || await getDeviceId(),
      lastSyncedAt: state.lastSyncedAt || null,
      cursor: state.cursor || null,
      syncStatus: state.syncStatus || 'idle',
      lastError: state.lastError || null,
      updatedAt: new Date().toISOString()
    };
    await DB().put(DB().STORES.SYNC, record);
    return record;
  }

  async function markSuccess({ cursor = null } = {}) {
    return save({
      id: 'default',
      cursor,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: 'idle',
      lastError: null
    });
  }

  async function markError(error) {
    return save({
      id: 'default',
      syncStatus: 'error',
      lastError: String(error?.message || error || 'Unknown sync error')
    });
  }

  return global.CinemaVaultSyncStateRepository = Object.freeze({
    getDeviceId,
    get,
    save,
    markSuccess,
    markError
  });
})(window);
