import { onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepositoryError } from '@/data/repositories/repositoryError';
import { createQueryClient } from '@/app/queryClient';

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('query client network behaviour (offline reads, online-only writes)', () => {
  it('runs queries even while the browser reports offline, so the saved copy can be offered', async () => {
    onlineManager.setOnline(false);
    const client = createQueryClient({ retry: false });
    const value = await client.query({ queryKey: ['u', 'x'], queryFn: () => 'ran' });
    expect(value).toBe('ran');
  });

  it('never parks a write while offline to replay it later: it runs now', async () => {
    onlineManager.setOnline(false);
    const client = createQueryClient({ retry: false });
    let calls = 0;
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => {
        calls += 1;
        return Promise.reject(new Error('network down'));
      },
    });
    await expect(mutation.execute(undefined)).rejects.toThrow('network down');
    expect(calls).toBe(1);
    expect(mutation.state.status).toBe('error'); // not 'pending' with isPaused
    expect(mutation.state.isPaused).toBe(false);
  });

  it('does not retry a write on its own', () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions().mutations?.retry).toBe(0);
  });
});

describe('query retry policy', () => {
  const retryFn = () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry;
    if (typeof retry !== 'function') throw new Error('expected a retry function');
    return retry;
  };
  const failure = (code: 'network' | 'forbidden') => new RepositoryError({ code, message: code });

  it('retries a transient failure once', () => {
    expect(retryFn()(0, failure('network'))).toBe(true);
    expect(retryFn()(1, failure('network'))).toBe(false);
  });

  it('never retries what a retry cannot fix', () => {
    expect(retryFn()(0, failure('forbidden'))).toBe(false);
  });

  it('does not wait to retry while the browser itself reports offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(retryFn()(0, failure('network'))).toBe(false);
  });
});
