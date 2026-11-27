import { describe, expect, it } from 'vitest';
import { parseEnv, resolveBackend } from '@/services/env';

const good = {
  VITE_SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_0123456789abcdefghijkl',
};

const jwt = (role: string) => `h.${btoa(JSON.stringify({ role })).replace(/=/g, '')}.s`;

describe('parseEnv', () => {
  it('accepts a valid configuration and defaults the app env', () => {
    const r = parseEnv(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.appEnv).toBe('development');
  });

  it('reports every missing variable', () => {
    const r = parseEnv({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.join(' ')).toMatch(/VITE_SUPABASE_URL/);
      expect(r.problems.join(' ')).toMatch(/VITE_SUPABASE_PUBLISHABLE_KEY/);
    }
  });

  it('rejects a non-https Supabase URL except for localhost', () => {
    expect(parseEnv({ ...good, VITE_SUPABASE_URL: 'http://example.com' }).ok).toBe(false);
    expect(parseEnv({ ...good, VITE_SUPABASE_URL: 'http://localhost:54321' }).ok).toBe(true);
  });

  it('rejects service-role / secret keys in the browser', () => {
    expect(
      parseEnv({ ...good, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_0123456789abcdefghijkl' }).ok,
    ).toBe(false);
    expect(
      parseEnv({ ...good, VITE_SUPABASE_PUBLISHABLE_KEY: jwt('service_role') + 'x'.repeat(20) }).ok,
    ).toBe(false);
    expect(
      parseEnv({ ...good, VITE_SUPABASE_PUBLISHABLE_KEY: jwt('anon') + 'x'.repeat(20) }).ok,
    ).toBe(true);
  });

  it.each([
    'VITE_SUPABASE_SERVICE_ROLE_KEY',
    'VITE_TMDB_API_KEY',
    'VITE_DB_PASSWORD',
    'VITE_SECRET_THING',
  ])('refuses a secret-looking VITE_ variable: %s', (name) => {
    const r = parseEnv({ ...good, [name]: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' ')).toContain(name);
  });

  it('rejects an unknown app environment', () => {
    expect(parseEnv({ ...good, VITE_APP_ENV: 'staging' }).ok).toBe(false);
  });
});

describe('production-database guard', () => {
  const PROD = 'https://ermjvreodaeovawbsbyh.supabase.co';

  it.each(['development', 'preview', undefined])(
    'refuses the production project when VITE_APP_ENV is %s',
    (appEnv) => {
      const r = parseEnv({
        ...good,
        VITE_SUPABASE_URL: PROD,
        ...(appEnv ? { VITE_APP_ENV: appEnv } : {}),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problems.join(' ')).toMatch(/PRODUCTION database/);
    },
  );

  it('allows the production project only when the build declares itself production', () => {
    expect(parseEnv({ ...good, VITE_SUPABASE_URL: PROD, VITE_APP_ENV: 'production' }).ok).toBe(
      true,
    );
  });

  it('allows any other project in development', () => {
    expect(parseEnv({ ...good, VITE_APP_ENV: 'development' }).ok).toBe(true);
  });
});

describe('resolveBackend', () => {
  it('uses Supabase when it is configured', () => {
    expect(resolveBackend(good, 'production').kind).toBe('supabase');
    expect(resolveBackend(good, 'development').kind).toBe('supabase');
  });

  it('uses sample data only when asked for, or on the dev server with nothing configured', () => {
    expect(resolveBackend({ VITE_DATA_SOURCE: 'mock' }, 'production').kind).toBe('mock');
    expect(resolveBackend({}, 'development').kind).toBe('mock');
  });

  it('never falls back to sample data in a production build', () => {
    const r = resolveBackend({}, 'production');
    expect(r.kind).toBe('misconfigured');
  });

  it('never falls back to sample data when Supabase is half-configured, even on the dev server', () => {
    const r = resolveBackend({ VITE_SUPABASE_URL: good.VITE_SUPABASE_URL }, 'development');
    expect(r.kind).toBe('misconfigured');
  });

  it('refuses sample data for a build that declares itself production', () => {
    expect(
      resolveBackend({ VITE_DATA_SOURCE: 'mock', VITE_APP_ENV: 'production' }, 'production').kind,
    ).toBe('misconfigured');
    expect(resolveBackend({ VITE_APP_ENV: 'production' }, 'development').kind).toBe(
      'misconfigured',
    );
  });

  it('rejects an unknown data source instead of guessing', () => {
    expect(resolveBackend({ ...good, VITE_DATA_SOURCE: 'sqlite' }, 'development').kind).toBe(
      'misconfigured',
    );
  });

  it('explicit supabase with nothing configured is an error, not sample data', () => {
    expect(resolveBackend({ VITE_DATA_SOURCE: 'supabase' }, 'development').kind).toBe(
      'misconfigured',
    );
  });

  it('a dev build pointed at production is misconfigured, not connected', () => {
    const r = resolveBackend(
      { ...good, VITE_SUPABASE_URL: 'https://ermjvreodaeovawbsbyh.supabase.co' },
      'development',
    );
    expect(r.kind).toBe('misconfigured');
  });
});
