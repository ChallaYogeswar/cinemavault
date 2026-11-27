import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseClient } from '@/data/supabase/client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Supabase client', () => {
  it('makes ONE request per read when the network is down — retry policy belongs to the app', async () => {
    const fetchStub = vi.fn((_url: unknown) => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', fetchStub);
    const client = createSupabaseClient({
      supabaseUrl: 'https://dev-project.supabase.co',
      supabasePublishableKey: 'sb_publishable_unit_test_key_000000',
      appEnv: 'development',
    });
    const started = Date.now();
    await client.from('movies').select('id').limit(1);
    // With PostgREST's own back-off (1 s + 2 s + 4 s) this would be ~7 s and four calls.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetchStub.mock.calls.filter(([url]) => String(url).includes('/rest/v1/'))).toHaveLength(
      1,
    );
  });
});
