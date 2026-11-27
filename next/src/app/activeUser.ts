/**
 * The single, synchronous answer to "who is signed in right now?".
 *
 * It deliberately lives OUTSIDE React state and OUTSIDE the signed-in component tree:
 *  - it changes the instant auth reports a change, not after the next render, so a request that
 *    finishes in between cannot slip through a stale-render window;
 *  - it outlives the signed-in tree, so a request started by the previous account still sees
 *    "someone else (or nobody) is signed in" after sign-out unmounts that tree.
 * Everything that must not leak across accounts (cache purge, mutation guards) reads or
 * subscribes to this store.
 *
 * `epoch` counts sign-in sessions. It increases on every change of account, including
 * A → B → A, so a request that started in A's FIRST session is still recognised as stale in A's
 * second one (comparing user ids alone would wrongly accept it).
 */
export interface ActiveUserStore {
  readonly get: () => string | null;
  readonly epoch: () => number;
  readonly set: (userId: string | null) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createActiveUserStore(initial: string | null = null): ActiveUserStore {
  let current = initial;
  let epoch = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    epoch: () => epoch,
    set: (next) => {
      if (next === current) return;
      current = next;
      epoch += 1;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
