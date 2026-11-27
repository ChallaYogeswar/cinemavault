import type { ProfileRepository } from '@/data/repositories/profileRepository';
import { ok, type AppError, type Result } from '@/domain/result';

export interface FakeProfiles extends ProfileRepository {
  /** What each user's profile row looks like (null = no row). Anything, including malformed data. */
  readonly rows: Map<string, unknown>;
  failNext(error: AppError): void;
  /** Hold the next load back until the returned function is called. */
  holdNext(): () => void;
  readonly loads: string[];
  /** The display name each user has saved (absent = none). */
  readonly names: Map<string, string>;
  /** Every `updateDisplayName` call, in order. */
  readonly updates: { readonly userId: string; readonly name: string | null }[];
  failNextUpdate(error: AppError): void;
}

export function createFakeProfiles(rows: Record<string, unknown>): FakeProfiles {
  const store = new Map(Object.entries(rows));
  let failure: AppError | null = null;
  let gate: Promise<void> | null = null;
  const loads: string[] = [];
  const names = new Map<string, string>();
  const updates: { userId: string; name: string | null }[] = [];
  let updateFailure: AppError | null = null;
  return {
    names,
    updates,
    failNextUpdate: (error) => {
      updateFailure = error;
    },
    rows: store,
    loads,
    failNext: (error) => {
      failure = error;
    },
    holdNext: () => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    async load(userId): Promise<Result<unknown>> {
      loads.push(userId);
      if (gate) {
        const pending = gate;
        gate = null;
        await pending;
      }
      if (failure) {
        const error = failure;
        failure = null;
        return { ok: false, error };
      }
      return store.has(userId) ? ok(store.get(userId)) : ok(null);
    },
    loadDisplayName(userId): Promise<Result<string | null>> {
      return Promise.resolve(ok(names.get(userId) ?? null));
    },
    updateDisplayName(userId, name): Promise<Result<string | null>> {
      updates.push({ userId, name });
      if (updateFailure) {
        const error = updateFailure;
        updateFailure = null;
        return Promise.resolve({ ok: false, error });
      }
      if (name === null) names.delete(userId);
      else names.set(userId, name);
      return Promise.resolve(ok(name));
    },
  };
}

export const networkFailure: AppError = { code: 'network', message: 'offline' };
