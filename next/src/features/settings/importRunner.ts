import type { MovieRepository } from '@/data/repositories/movieRepository';
import type { MovieInputValues } from '@/domain/validation';

export const IMPORT_CHUNK = 200;

export interface ImportProgress {
  readonly done: number;
  readonly total: number;
}

export interface ImportSummary {
  /** Titles saved. */
  readonly created: number;
  /** Rows the server skipped (a duplicate that appeared since the preview, or an invalid value). */
  readonly skipped: number;
  /** Rows never attempted because the import stopped. */
  readonly notAttempted: number;
  /** Why it stopped early, in words for the person; null when every row was attempted. */
  readonly stopped: string | null;
  readonly cancelled: boolean;
}

interface RunOptions {
  readonly repository: MovieRepository;
  readonly inputs: readonly MovieInputValues[];
  readonly signal?: AbortSignal;
  /** False once the signed-in account changed: the import then stops without a word. */
  readonly isCurrent: () => boolean;
  readonly onProgress?: (progress: ImportProgress) => void;
  readonly chunkSize?: number;
}

/**
 * Saves the rows in chunks so progress is real, a cancel takes effect between chunks, and a lost
 * connection costs at most one chunk. Safe to run again after any stop: rows that were already
 * saved are then reported as duplicates by the repository and skipped, never saved twice.
 */
export async function runImport(options: RunOptions): Promise<ImportSummary> {
  const { repository, inputs, signal, isCurrent, onProgress } = options;
  const size = Math.max(1, options.chunkSize ?? IMPORT_CHUNK);
  let created = 0;
  let skipped = 0;
  let attempted = 0;
  let stopped: string | null = null;
  let cancelled = false;

  for (let start = 0; start < inputs.length; start += size) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    if (!isCurrent()) break;
    const chunk = inputs.slice(start, start + size);
    const result = await repository.createMany(chunk);
    if (!isCurrent()) break;
    if (!result.ok) {
      stopped =
        result.error.code === 'network'
          ? 'The connection was lost. Run the import again when you are online: titles already added are skipped.'
          : result.error.message;
      break;
    }
    created += result.value.created.length;
    skipped += result.value.skipped.length;
    attempted += chunk.length;
    onProgress?.({ done: attempted, total: inputs.length });
  }
  return { created, skipped, notAttempted: inputs.length - attempted, stopped, cancelled };
}
