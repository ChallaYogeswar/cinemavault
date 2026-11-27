import type { Role } from '@/domain/permissions';
import { MOCK_OWNER_ID, createSeedMovies, generateMovies } from './fixtures';
import { createMockMovieRepository, type MockMovieRepository } from './mockMovieRepository';

/**
 * Preview scenarios for milestone M2, chosen with `?scenario=` so every state of the UI can be
 * reviewed without code changes. They only select MOCK data; none of them reaches a network.
 * Replaced by the real repository wiring in M3.
 */
export const SCENARIOS = ['default', 'empty', 'error', 'slow', 'large'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export function parseScenario(search: string): Scenario {
  const value = new URLSearchParams(search).get('scenario');
  return SCENARIOS.find((candidate) => candidate === value) ?? 'default';
}

/** `?as=viewer` opens the preview in view-only mode. Anything else previews the owner. */
export function parsePreviewRole(search: string): Role {
  return new URLSearchParams(search).get('as') === 'viewer' ? 'viewer' : 'owner';
}

export function createScenarioRepository(
  scenario: Scenario,
  getRole: () => Role,
  ownerId: string = MOCK_OWNER_ID,
): MockMovieRepository {
  switch (scenario) {
    case 'empty':
      return createMockMovieRepository({ seed: [], getRole, ownerId });
    case 'error':
      return createMockMovieRepository({
        getRole,
        ownerId,
        alwaysFail: { code: 'network', message: 'The mock server is unreachable.' },
      });
    case 'slow':
      return createMockMovieRepository({ getRole, ownerId, latencyMs: 1_800 });
    case 'large':
      return createMockMovieRepository({ seed: generateMovies(3_243, ownerId), getRole, ownerId });
    case 'default':
      return createMockMovieRepository({ seed: createSeedMovies(ownerId), getRole, ownerId });
  }
}
