import type { ReactNode } from 'react';
import { RepositoryContext } from '@/app/repository';
import { useSession } from '@/app/session';
import type { MockMovieRepository } from '@/data/mock/mockMovieRepository';

export function AccountRepository({
  repoFor,
  children,
}: {
  readonly repoFor: (userId: string) => MockMovieRepository;
  readonly children: ReactNode;
}) {
  const { userId } = useSession();
  return <RepositoryContext value={repoFor(userId)}>{children}</RepositoryContext>;
}
