import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '@/app/ConfigurationError';
import { Providers } from '@/app/providers';

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState(null, '', '/');
});

describe('ConfigurationError', () => {
  it('lists every problem', () => {
    render(<ConfigurationError problems={['first problem', 'second problem']} />);
    expect(screen.getByRole('alert')).toHaveTextContent('first problem');
    expect(screen.getByRole('alert')).toHaveTextContent('second problem');
  });
});

describe('Providers: which backend the app starts on', () => {
  it('a build with broken configuration shows an error and NO library, sample or real', () => {
    vi.stubEnv('VITE_DATA_SOURCE', '');
    vi.stubEnv('VITE_SUPABASE_URL', 'not a url');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');
    render(<Providers />);
    expect(screen.getByRole('alert')).toHaveTextContent(/isn’t configured/i);
    expect(screen.queryByRole('link', { name: /library/i })).not.toBeInTheDocument();
  });

  it('a build pointed at production without declaring itself production is refused', () => {
    vi.stubEnv('VITE_DATA_SOURCE', 'supabase');
    vi.stubEnv('VITE_APP_ENV', 'development');
    vi.stubEnv('VITE_SUPABASE_URL', 'https://qhopjfqpnmoinggejgvt.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_0123456789abcdefghijkl');
    render(<Providers />);
    expect(screen.getByRole('alert')).toHaveTextContent(/PRODUCTION database/);
  });

  it('sample data must be asked for, and then says so', async () => {
    vi.stubEnv('VITE_DATA_SOURCE', 'mock');
    vi.stubEnv('VITE_APP_ENV', 'development');
    render(<Providers />);
    expect(await screen.findByText(/preview mode/i)).toBeInTheDocument();
  });

  it('sample data is refused for a production build', () => {
    vi.stubEnv('VITE_DATA_SOURCE', 'mock');
    vi.stubEnv('VITE_APP_ENV', 'production');
    render(<Providers />);
    expect(screen.getByRole('alert')).toHaveTextContent(/not allowed/i);
  });

  it('a real backend starts signed out, at the sign-in page', async () => {
    vi.stubEnv('VITE_DATA_SOURCE', 'supabase');
    vi.stubEnv('VITE_APP_ENV', 'development');
    vi.stubEnv('VITE_SUPABASE_URL', 'https://devprojectref000000.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_0123456789abcdefghijkl');
    window.history.replaceState(null, '', '/library');
    render(<Providers />);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
