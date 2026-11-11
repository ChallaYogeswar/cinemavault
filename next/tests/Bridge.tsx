import { useState, type ReactNode } from 'react';
import { RepositoryContext } from '@/app/repository';
import { useSession } from '@/app/session';
import type { MockMovieRepository } from '@/data/mock/mockMovieRepository';
import type { Role } from '@/domain/permissions';

/** Builds the repository from inside the session so role changes reach it, like production wiring. */
export function Bridge({
  make,
  children,
}: {
  readonly make: (getRole: () => Role) => MockMovieRepository;
  readonly children: ReactNode;
}) {
  const { getRole } = useSession();
  const [repository] = useState(() => make(getRole));
  return <RepositoryContext value={repository}>{children}</RepositoryContext>;
}
