import { createContext, useContext } from 'react';
import type { MovieRepository } from '@/data/repositories/movieRepository';

export const RepositoryContext = createContext<MovieRepository | null>(null);

/** The only way UI code reaches data: through the contract, never a concrete implementation. */
export function useMovieRepository(): MovieRepository {
  const repository = useContext(RepositoryContext);
  if (!repository) throw new Error('useMovieRepository must be used inside <RepositoryContext>');
  return repository;
}
