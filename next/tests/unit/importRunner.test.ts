import { describe, expect, it, vi } from 'vitest';
import { createMockMovieRepository } from '@/data/mock/mockMovieRepository';
import { EMPTY_MOVIE_INPUT } from '@/domain/movieInput';
import { err } from '@/domain/result';
import { runImport } from '../../src/features/settings/importRunner';

const rows = (n: number, prefix = 'Row') =>
  Array.from({ length: n }, (_, i) => ({
    ...EMPTY_MOVIE_INPUT,
    title: `${prefix} ${String(i)}`,
    year: 2020,
  }));
const emptyRepo = () => createMockMovieRepository({ seed: [] });

describe('runImport', () => {
  it('saves everything in chunks and reports progress after each', async () => {
    const repo = emptyRepo();
    const progress: number[] = [];
    const out = await runImport({
      repository: repo,
      inputs: rows(25),
      chunkSize: 10,
      isCurrent: () => true,
      onProgress: (p) => progress.push(p.done),
    });
    expect(out).toMatchObject({
      created: 25,
      skipped: 0,
      notAttempted: 0,
      stopped: null,
      cancelled: false,
    });
    expect(progress).toEqual([10, 20, 25]);
    expect(repo.snapshot()).toHaveLength(25);
  });

  it('a cancel takes effect between chunks and reports what was not attempted', async () => {
    const repo = emptyRepo();
    const controller = new AbortController();
    const out = await runImport({
      repository: repo,
      inputs: rows(25),
      chunkSize: 10,
      signal: controller.signal,
      isCurrent: () => true,
      onProgress: (p) => {
        if (p.done === 10) controller.abort();
      },
    });
    expect(out).toMatchObject({ created: 10, notAttempted: 15, cancelled: true });
    expect(repo.snapshot()).toHaveLength(10);
  });

  it('a lost connection stops the import; running it again adds only the rest, never twice', async () => {
    const repo = emptyRepo();
    const inputs = rows(25);
    let calls = 0;
    const flaky = {
      ...repo,
      createMany: (batch: Parameters<typeof repo.createMany>[0]) => {
        calls += 1;
        return calls === 2 ? Promise.resolve(err('network', 'down')) : repo.createMany(batch);
      },
    };
    const first = await runImport({
      repository: flaky,
      inputs,
      chunkSize: 10,
      isCurrent: () => true,
    });
    expect(first.created).toBe(10);
    expect(first.notAttempted).toBe(15);
    expect(first.stopped).toContain('connection was lost');

    const second = await runImport({
      repository: flaky,
      inputs,
      chunkSize: 10,
      isCurrent: () => true,
    });
    expect(second.created).toBe(15);
    expect(second.skipped).toBe(10); // the first ten are recognised as already added
    expect(repo.snapshot()).toHaveLength(25);
    expect(new Set(repo.snapshot().map((m) => m.title)).size).toBe(25);
  });

  it('stops silently, without another request, when the account changed', async () => {
    const repo = emptyRepo();
    const spy = vi.spyOn(repo, 'createMany');
    let current = true;
    const out = await runImport({
      repository: repo,
      inputs: rows(30),
      chunkSize: 10,
      isCurrent: () => current,
      onProgress: () => {
        current = false;
      },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.notAttempted).toBe(20);
  });

  it('reports a refusal (view-only) in words and saves nothing', async () => {
    const repo = createMockMovieRepository({ seed: [], getRole: () => 'viewer' });
    const out = await runImport({ repository: repo, inputs: rows(5), isCurrent: () => true });
    expect(out.created).toBe(0);
    expect(out.stopped).toContain('view-only');
  });

  it('does nothing for an empty list', async () => {
    const out = await runImport({ repository: emptyRepo(), inputs: [], isCurrent: () => true });
    expect(out).toEqual({
      created: 0,
      skipped: 0,
      notAttempted: 0,
      stopped: null,
      cancelled: false,
    });
  });
});
