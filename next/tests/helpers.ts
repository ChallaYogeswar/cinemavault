import type { Result } from '@/domain/result';

/** Unwraps a Result in a test, failing loudly with the error message instead of using `!`. */
export function must<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`Expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** First element of a list that the test knows is non-empty. */
export function first<T>(list: readonly T[]): T {
  const item = list[0];
  if (item === undefined) throw new Error('Expected a non-empty list');
  return item;
}

/** Element at a position the test knows exists. */
export function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`Expected an element at ${index}`);
  return item;
}

export function findOrThrow<T>(list: readonly T[], predicate: (item: T) => boolean): T {
  const item = list.find(predicate);
  if (item === undefined) throw new Error('Expected a matching item');
  return item;
}
