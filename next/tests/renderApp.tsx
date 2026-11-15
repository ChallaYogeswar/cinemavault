import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { Bridge } from './Bridge';
import { SessionFromAuth } from './SessionFromAuth';
import { createActiveUserStore } from '@/app/activeUser';
import { createQueryClient } from '@/app/queryClient';
import { createTestRouter } from '@/app/router';
import { ActiveUserContext } from '@/app/activeUserContext';
import { MockAuthProvider } from '@/app/auth/MockAuthProvider';
import { RuntimeContext } from '@/app/runtime';
import { PrivateCacheGuard } from '@/app/PrivateCacheGuard';
import { MOCK_OWNER_ID } from '@/data/mock/fixtures';
import { ToastProvider } from '@/components/ui/ToastProvider';
import {
  createMockMovieRepository,
  type MockMovieRepository,
  type MockRepositoryOptions,
} from '@/data/mock/mockMovieRepository';
import type { Role } from '@/domain/permissions';
import type { AppError } from '@/domain/result';

interface Options {
  readonly path?: string;
  /** Full history to start from (with `index`) for Back/Forward tests. Overrides `path`. */
  readonly entries?: string[];
  readonly index?: number;
  readonly role?: Role;
  /** Extra options for the mock repository (seed, alwaysFail, latency, …). */
  readonly repository?: Omit<MockRepositoryOptions, 'getRole'>;
  /** Hold the first list response back until `release()` (a slow initial load). */
  readonly holdFirstList?: boolean;
  /** Make exactly the first repository call (the initial load) fail, then recover. */
  readonly failFirstCall?: AppError;
}

export function renderApp({
  path = '/library',
  entries,
  index,
  role = 'owner',
  repository,
  failFirstCall,
  holdFirstList = false,
}: Options = {}) {
  let created: MockMovieRepository | undefined;
  let releaseFirstList: () => void = () => undefined;
  const router = createTestRouter(entries ?? [path], index);
  const queryClient = createQueryClient({ retry: false });
  const activeUser = createActiveUserStore(MOCK_OWNER_ID);
  const user = userEvent.setup();

  render(
    <QueryClientProvider client={queryClient}>
      <ActiveUserContext value={activeUser}>
        <PrivateCacheGuard store={activeUser} />
        <MockAuthProvider store={activeUser} initialRole={role}>
          <SessionFromAuth>
            <Bridge
              make={(getRole) => {
                created = createMockMovieRepository({ ...repository, getRole });
                if (failFirstCall) created.failNext(failFirstCall);
                if (holdFirstList) releaseFirstList = created.holdNextList();
                return created;
              }}
            >
              <RuntimeContext
                value={{
                  kind: 'mock',
                  profiles: null,
                  libraryCache: null,
                  history: null,
                  snoozes: null,
                  outbox: null,
                  roles: null,
                  metadata: null,
                  repositoryFor: () => {
                    throw new Error('renderApp supplies the repository directly');
                  },
                }}
              >
                <ToastProvider>
                  <RouterProvider router={router} />
                </ToastProvider>
              </RuntimeContext>
            </Bridge>
          </SessionFromAuth>
        </MockAuthProvider>
      </ActiveUserContext>
    </QueryClientProvider>,
  );

  if (!created) throw new Error('repository was not created');
  return {
    user,
    router,
    repository: created,
    queryClient,
    activeUser,
    releaseFirstList: () => {
      releaseFirstList();
    },
  };
}
