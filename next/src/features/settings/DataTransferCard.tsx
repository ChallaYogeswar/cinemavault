import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { moviesKey } from '@/app/privateKey';
import { useMovieRepository } from '@/app/repository';
import { useSession } from '@/app/session';
import { Button } from '@/components/ui/Button';
import { useMoviesQuery, useWriteAccess } from '@/features/library/queries';
import {
  IMPORT_MAX_BYTES,
  buildCsvExport,
  buildJsonExport,
  parseImportFile,
  planImport,
  type ImportPlan,
  type PlannedRow,
} from '@/domain/transfer';
import { card } from './cardStyle';
import { runImport, type ImportProgress, type ImportSummary } from './importRunner';

function download(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

const stamp = (): string => new Date().toISOString().slice(0, 10);

const STATUS_WORDS: Record<PlannedRow['status'], string> = {
  new: 'will be added',
  exists: 'already in your library',
  repeated: 'repeated in the file',
  invalid: 'cannot be saved',
};

interface Preview {
  readonly plan: ImportPlan;
  readonly fileName: string;
  readonly notes: readonly string[];
}

/**
 * Backup and restore. Export works for anyone, offline too (it writes what is on screen). Import
 * can only ADD titles: nothing is saved before a preview, duplicates and invalid rows are skipped,
 * and running it twice adds nothing the second time.
 */
export function DataTransferCard() {
  const library = useMoviesQuery();
  const write = useWriteAccess();
  const repository = useMovieRepository();
  const { userId, isCurrent } = useSession();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const movies = library.data;
  const exportDisabled = movies === undefined;
  const canImport = write.can('movie:create');
  const importing = progress !== null;

  const exportAs = async (kind: 'json' | 'csv') => {
    if (!movies) return;
    setProblem(null);
    if (kind === 'json') {
      download(
        `cinemavault-${stamp()}.json`,
        await buildJsonExport(movies, new Date()),
        'application/json',
      );
    } else {
      download(`cinemavault-${stamp()}.csv`, buildCsvExport(movies), 'text/csv');
    }
    setNotice(`Saved ${String(movies.length)} titles to your downloads.`);
  };

  const choose = async (file: File | undefined) => {
    setNotice(null);
    setProblem(null);
    setSummary(null);
    setPreview(null);
    if (!file || !movies) return;
    if (file.size > IMPORT_MAX_BYTES) {
      setProblem('That file is larger than 5 MB, so it is probably not a library file.');
      return;
    }
    let source: string;
    try {
      source = await file.text();
    } catch {
      setProblem('That file could not be read.');
      return;
    }
    const parsed = await parseImportFile(source);
    if (!parsed.ok) {
      setProblem(parsed.message);
      return;
    }
    const notes: string[] = [];
    if (parsed.checksum === 'mismatch') {
      notes.push(
        'This backup was changed after it was exported (or is damaged). Check the preview.',
      );
    }
    if (parsed.ignoredColumns.length > 0) {
      notes.push(`Ignored columns: ${parsed.ignoredColumns.join(', ')}.`);
    }
    setPreview({ plan: planImport(parsed.rows, movies), fileName: file.name, notes });
  };

  const start = async () => {
    if (!preview || preview.plan.toCreate.length === 0) return;
    const controller = new AbortController();
    abort.current = controller;
    setProblem(null);
    setProgress({ done: 0, total: preview.plan.toCreate.length });
    const result = await runImport({
      repository,
      inputs: preview.plan.toCreate,
      signal: controller.signal,
      isCurrent,
      onProgress: setProgress,
    });
    abort.current = null;
    if (!isCurrent()) return; // another account is on screen now; nothing here is theirs
    setProgress(null);
    setPreview(null);
    setSummary(result);
    if (fileInput.current) fileInput.current.value = '';
    await queryClient.cancelQueries({ queryKey: moviesKey(userId) });
    void queryClient.invalidateQueries({ queryKey: moviesKey(userId) });
  };

  const problems = preview?.plan.rows.filter((row) => row.status !== 'new').slice(0, 20) ?? [];

  return (
    <div className={card}>
      <h2 className="font-serif text-2xl">Backup and import</h2>
      <p className="text-muted mt-2 text-sm">
        Download your library as a backup, or add titles from a backup or a spreadsheet. Importing
        only adds titles: nothing you already have is changed or removed.
      </p>

      <h3 className="mt-5 text-sm font-semibold">Export</h3>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={exportDisabled}
          onClick={() => {
            void exportAs('json');
          }}
        >
          Download backup (JSON)
        </Button>
        <Button
          variant="secondary"
          disabled={exportDisabled}
          onClick={() => {
            void exportAs('csv');
          }}
        >
          Download spreadsheet (CSV)
        </Button>
      </div>
      <p className="text-dim mt-2 text-xs">
        {movies ? `${String(movies.length)} titles on screen. ` : 'Loading your library… '}
        The backup contains only what you typed: no account details.
      </p>

      <h3 className="mt-5 text-sm font-semibold">Import</h3>
      {!write.roleAllows('movie:create') ? (
        <p className="text-muted mt-2 text-sm">View-only accounts can’t import titles.</p>
      ) : write.savedCopy ? (
        <p className="text-muted mt-2 text-sm">
          Importing needs a connection. Reconnect and this unlocks.
        </p>
      ) : (
        <div className="mt-2">
          <label htmlFor="import-file" className="text-muted block text-sm">
            Choose a backup (.json) or a spreadsheet saved as .csv
          </label>
          <input
            id="import-file"
            ref={fileInput}
            type="file"
            accept=".json,.csv,.txt,application/json,text/csv"
            disabled={!canImport || importing || movies === undefined}
            className="file:border-line file:bg-surface-2 file:text-text mt-2 block w-full text-sm file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-full file:border file:px-4 file:text-sm file:font-semibold"
            onChange={(event) => {
              void choose(event.target.files?.[0]);
            }}
          />
        </div>
      )}

      {problem ? (
        <p role="alert" className="text-danger mt-3 text-sm">
          {problem}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-muted mt-3 text-sm">
          {notice}
        </p>
      ) : null}

      {preview ? (
        <div className="mt-4">
          <p className="text-sm font-semibold">Preview of {preview.fileName}</p>
          <dl className="mt-2 grid max-w-xs grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
            <dt>Will be added</dt>
            <dd className="font-mono">{preview.plan.counts.new}</dd>
            <dt>Already in your library</dt>
            <dd className="font-mono">{preview.plan.counts.exists}</dd>
            <dt>Repeated in the file</dt>
            <dd className="font-mono">{preview.plan.counts.repeated}</dd>
            <dt>Cannot be saved</dt>
            <dd className="font-mono">{preview.plan.counts.invalid}</dd>
          </dl>
          {preview.notes.map((note) => (
            <p key={note} role="status" className="text-muted mt-2 text-xs">
              {note}
            </p>
          ))}
          {problems.length > 0 ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm">
                Rows that will be skipped (
                {String(preview.plan.counts.total - preview.plan.counts.new)})
              </summary>
              <ul className="text-muted mt-2 max-h-56 space-y-1 overflow-auto text-xs">
                {problems.map((row) => (
                  <li key={row.line}>
                    Row {row.line}: {row.input?.title ?? 'no title'} — {STATUS_WORDS[row.status]}
                    {row.problems.length > 0 ? ` (${row.problems.join('; ')})` : ''}
                  </li>
                ))}
              </ul>
              {preview.plan.counts.total - preview.plan.counts.new > problems.length ? (
                <p className="text-dim mt-1 text-xs">
                  Showing the first {String(problems.length)}.
                </p>
              ) : null}
            </details>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={preview.plan.counts.new === 0 || importing || !canImport}
              onClick={() => {
                void start();
              }}
            >
              {importing
                ? 'Importing…'
                : `Import ${String(preview.plan.counts.new)} new ${preview.plan.counts.new === 1 ? 'title' : 'titles'}`}
            </Button>
            {importing ? (
              <Button
                variant="ghost"
                onClick={() => {
                  abort.current?.abort();
                }}
              >
                Stop after this batch
              </Button>
            ) : (
              <Button
                variant="ghost"
                onClick={() => {
                  setPreview(null);
                  if (fileInput.current) fileInput.current.value = '';
                }}
              >
                Cancel
              </Button>
            )}
          </div>
          {progress ? (
            <div role="status" className="mt-3">
              <progress
                className="w-full"
                max={progress.total}
                value={progress.done}
                aria-label="Import progress"
              />
              <p className="text-muted mt-1 text-xs">
                {String(progress.done)} of {String(progress.total)} processed
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {summary ? (
        <div role="status" className="mt-4 text-sm">
          <p className="font-semibold">
            {summary.cancelled
              ? 'Import stopped.'
              : summary.stopped
                ? 'Import stopped early.'
                : 'Import finished.'}
          </p>
          <p className="text-muted mt-1">
            {String(summary.created)} added
            {summary.skipped > 0
              ? `, ${String(summary.skipped)} skipped as duplicates or invalid`
              : ''}
            {summary.notAttempted > 0 ? `, ${String(summary.notAttempted)} not attempted` : ''}.
          </p>
          {summary.stopped ? <p className="text-danger mt-1">{summary.stopped}</p> : null}
          {summary.cancelled && summary.notAttempted > 0 ? (
            <p className="text-muted mt-1">Choose the same file again to add the rest.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
