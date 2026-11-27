import type { Movie } from './movie';
import type { MovieInputValues } from './validation';

/** The editable subset of a stored movie, shaped for the form and the repository. */
export function movieToInput(movie: Movie): MovieInputValues {
  return {
    title: movie.title,
    mediaType: movie.mediaType,
    year: movie.year,
    genre: movie.genre,
    runtimeMinutes: movie.runtimeMinutes,
    watched: movie.watched,
    watchedOn: movie.watchedOn,
    userRating: movie.userRating,
    verdict: movie.verdict,
    technicalNotes: movie.technicalNotes,
    shotLink: movie.shotLink,
  };
}

export const EMPTY_MOVIE_INPUT: MovieInputValues = {
  title: '',
  mediaType: 'movie',
  year: null,
  genre: null,
  runtimeMinutes: null,
  watched: false,
  watchedOn: null,
  userRating: null,
  verdict: null,
  technicalNotes: null,
  shotLink: null,
};

export const FIELD_LABELS: Record<keyof MovieInputValues, string> = {
  title: 'Title',
  mediaType: 'Type',
  year: 'Year',
  genre: 'Genre',
  runtimeMinutes: 'Runtime',
  watched: 'Watched',
  watchedOn: 'Watched on',
  userRating: 'Rating',
  verdict: 'Verdict',
  technicalNotes: 'Technical notes',
  shotLink: 'Screenshot link',
};

/** Fields whose values differ between two versions, in a stable display order. */
export function changedFields(
  a: MovieInputValues,
  b: MovieInputValues,
): (keyof MovieInputValues)[] {
  return (Object.keys(FIELD_LABELS) as (keyof MovieInputValues)[]).filter(
    (field) => !Object.is(a[field], b[field]),
  );
}
