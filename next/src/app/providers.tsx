import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { MOCK_OWNER_ID } from '@/data/mock/fixtures';
import { createScenarioRepository, parsePreviewRole, parseScenario } from '@/data/mock/scenarios';
import { createDexieDeviceStore } from '@/data/local/dexieLibraryCache';
import { AUTH_STORAGE_KEY, createSupabaseClient } from '@/data/supabase/client';
import { createSupabaseMovieRepository } from '@/data/supabase/supabaseMovieRepository';
import { createSupabaseProfileRepository } from '@/data/supabase/supabaseProfileRepository';
import { createSupabaseAuthService } from '@/services/auth/supabaseAuthService';
import { readStoredIdentity } from '@/services/auth/storedIdentity';
import { loadBackend, type Backend } from '@/services/env';
import { createMetadataService } from '@/services/tmdb/metadataService';
import { createTmdbClient } from '@/services/tmdb/tmdbClient';
import { createActiveUserStore } from './activeUser';
import { ActiveUserContext } from './activeUserContext';
import { AuthProvider } from './auth/AuthProvider';
import { MockAuthProvider } from './auth/MockAuthProvider';
import { ConfigurationError } from './ConfigurationError';
import { PrivateCacheGuard } from './PrivateCacheGuard';
import { UpdateBanner } from '@/pwa/UpdateBanner';
import { createQueryClient } from './queryClient';
import { createAppRouter } from './router';
import { RuntimeContext, type Runtime } from './runtime';

type Ready = Exclude<Backend, { kind: 'misconfigured' }>;

function App({ backend }: { readonly backend: Ready }) {
  const [queryClient] = useState(() => createQueryClient());
  const [router] = useState(createAppRouter);
  const [setup] = useState(() => {
    if (backend.kind === 'supabase') {
      const client = createSupabaseClient(backend.config);
      const device = createDexieDeviceStore();
      const runtime: Runtime = {
        kind: 'supabase',
        repositoryFor: (userId, getRole) =>
          createSupabaseMovieRepository({ client, userId, getRole }),
        profiles: createSupabaseProfileRepository(client),
        libraryCache: device.library,
        history: device.history,
        snoozes: device.snoozes,
        metadata: createMetadataService({
          client: createTmdbClient({
            getToken: async () =>
              (await client.auth.getSession()).data.session?.access_token ?? null,
          }),
          store: device.metadata,
        }),
      };
      const service = createSupabaseAuthService({
        client,
        siteUrl: () => window.location.origin,
        storedIdentity: () => readStoredIdentity(AUTH_STORAGE_KEY),
      });
      return { runtime, store: createActiveUserStore(null), service, preview: null };
    }
    // Sample data, explicitly requested. `?scenario=` and `?as=viewer` only exist in this mode.
    const preview = {
      scenario: parseScenario(window.location.search),
      role: parsePreviewRole(window.location.search),
    };
    const runtime: Runtime = {
      kind: 'mock',
      repositoryFor: (userId, getRole) =>
        createScenarioRepository(preview.scenario, getRole, userId),
      profiles: null,
      libraryCache: null, // sample data is not private and has nothing to keep on the device
      history: null,
      snoozes: null,
      metadata: null,
    };
    return { runtime, store: createActiveUserStore(MOCK_OWNER_ID), service: null, preview };
  });

  const body = (
    <ToastProvider>
      <UpdateBanner />
      <RouterProvider router={router} />
    </ToastProvider>
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ActiveUserContext value={setup.store}>
        <PrivateCacheGuard store={setup.store} saved={setup.runtime.libraryCache} />
        <RuntimeContext value={setup.runtime}>
          {setup.service ? (
            <AuthProvider
              service={setup.service}
              store={setup.store}
              saved={setup.runtime.libraryCache}
            >
              {body}
            </AuthProvider>
          ) : (
            <MockAuthProvider store={setup.store} initialRole={setup.preview.role}>
              {body}
            </MockAuthProvider>
          )}
        </RuntimeContext>
      </ActiveUserContext>
    </QueryClientProvider>
  );
}

export function Providers() {
  const [backend] = useState(loadBackend);
  if (backend.kind === 'misconfigured') return <ConfigurationError problems={backend.problems} />;
  return <App backend={backend} />;
}
