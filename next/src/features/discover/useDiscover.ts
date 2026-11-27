import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { privateKey } from '@/app/privateKey';
import { useRuntime } from '@/app/runtime';
import { useSession } from '@/app/session';
import { HISTORY_LIMIT, SNOOZE_DAYS } from '@/data/local/deviceData';
import type { Movie } from '@/domain/movie';
import {
  freshHistory,
  historyEntryFor,
  inventory,
  isEligible,
  narrow,
  pickFacts,
  pickGlobal,
  pickInGenre,
  type GenreInventory,
  type HistoryEntry,
  type KindFilter,
  type Pick,
} from '@/domain/recommend';
import { useMoviesQuery } from '@/features/library/queries';

export interface KindCounts {
  readonly all: number;
  readonly movie: number;
  readonly tv: number;
}

export interface Discover {
  readonly library: ReturnType<typeof useMoviesQuery>;
  /** The suggestion on screen, always resolved against the live library. Null until the first pick. */
  readonly pick: Pick | null;
  /** True when the title that was on screen has since been watched or deleted. */
  readonly pickGone: boolean;
  /** Checkable facts about the suggestion (time on the list, genre progress, length). */
  readonly facts: readonly string[];
  /** Unwatched titles by genre (within the chosen kind), biggest backlog first. */
  readonly genres: readonly GenreInventory[];
  /** The genre being drawn from, or null for the balanced pick across everything. */
  readonly genre: string | null;
  /** Films only, series only, or both (null). */
  readonly kind: KindFilter;
  /** Every unwatched title, whatever the filters and whatever is hidden. */
  readonly eligibleCount: number;
  /** Unwatched titles that a pick may be drawn from right now (kind chosen, nothing hidden). */
  readonly availableCount: number;
  /** How many unwatched titles of each kind could be picked (hidden ones excluded). */
  readonly kindCounts: KindCounts;
  /** Unwatched titles currently hidden by "Not now". */
  readonly hiddenCount: number;
  /** Titles shown lately (within the last month), newest first, that are still in the library. */
  readonly recent: readonly Movie[];
  readonly choose: (genre: string | null) => void;
  readonly chooseKind: (kind: KindFilter) => void;
  readonly pickAnother: () => void;
  /** Hides a title for `SNOOZE_DAYS` days and picks something else. */
  readonly hide: (movieId: string) => void;
  /** Brings every hidden title back. */
  readonly showHidden: () => void;
}

const DAY_MS = 86_400_000;
const parseKind = (value: string | null): KindFilter =>
  value === 'movie' || value === 'tv' ? value : null;

/**
 * Drives Discover: which suggestion is on screen, what was suggested lately and which titles the
 * person asked not to see for a while (both kept per account on this device). It only reads the
 * library; nothing here changes it, so it works from the saved copy while offline.
 */
export function useDiscover(random: () => number = Math.random): Discover {
  const library = useMoviesQuery();
  const { history, snoozes } = useRuntime();
  const { userId, isCurrent } = useSession();
  const queryClient = useQueryClient();
  const historyKey = useMemo(() => privateKey(userId, 'history'), [userId]);
  const snoozeKey = useMemo(() => privateKey(userId, 'snoozed'), [userId]);

  const saved = useQuery({
    queryKey: historyKey,
    queryFn: async (): Promise<readonly HistoryEntry[]> =>
      history ? history.recent(userId, HISTORY_LIMIT) : [],
    staleTime: Infinity,
  });
  const snoozed = useQuery({
    queryKey: snoozeKey,
    queryFn: async (): Promise<readonly string[]> =>
      snoozes ? snoozes.active(userId, new Date()) : [],
    staleTime: Infinity,
  });

  // `/discover?genre=Drama&type=tv` (from the Genres page, say) starts there; else balanced.
  const [params] = useSearchParams();
  const [genre, setGenre] = useState<string | null>(
    () => (params.get('genre') ?? '').slice(0, 100) || null,
  );
  const [kind, setKind] = useState<KindFilter>(() => parseKind(params.get('type')));
  const [shown, setShown] = useState<Pick | null>(null);
  const seen = useRef<string[]>([]); // titles shown on this visit, so "another" does not cycle back
  const started = useRef(false);
  // The time of the latest pick (or of opening the page): what "now" means for the lists below.
  const [clock, setClock] = useState(() => new Date());

  const movies = library.data;
  const hidden = useMemo(() => new Set(snoozed.data ?? []), [snoozed.data]);
  const ready = movies !== undefined && saved.data !== undefined && snoozed.data !== undefined;

  const roll = useCallback(
    (next: {
      readonly genre: string | null;
      readonly kind: KindFilter;
      readonly hidden: ReadonlySet<string>;
    }) => {
      if (!movies) return;
      const now = new Date();
      const entries = queryClient.getQueryData<readonly HistoryEntry[]>(historyKey) ?? [];
      const options = {
        movies: narrow(movies, { kind: next.kind, hidden: next.hidden }),
        history: freshHistory(entries, now),
        random,
        avoid: seen.current,
        ...(seen.current[0] ? { current: seen.current[0] } : {}),
      };
      // A genre with nothing left falls back to the balanced pick rather than showing nothing.
      const picked =
        (next.genre === null ? null : pickInGenre({ ...options, genre: next.genre })) ??
        pickGlobal(options);
      if (!picked) {
        setShown(null);
        return;
      }
      seen.current = [picked.movie.id, ...seen.current].slice(0, 30);
      setShown(picked);
      const entry = historyEntryFor(picked, now);
      setClock(now);
      if (isCurrent()) {
        queryClient.setQueryData<readonly HistoryEntry[]>(
          historyKey,
          [entry, ...entries].slice(0, HISTORY_LIMIT),
        );
        void history?.record(userId, entry);
      }
    },
    [movies, queryClient, historyKey, random, isCurrent, history, userId],
  );

  // The first suggestion appears as soon as the library, history and hidden titles are known.
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    roll({ genre, kind, hidden });
  }, [ready, roll, genre, kind, hidden]);

  const eligible = useMemo(() => (movies ?? []).filter(isEligible), [movies]);
  const pool = useMemo(() => narrow(eligible, { kind, hidden }), [eligible, kind, hidden]);
  const genres = useMemo(() => inventory(pool), [pool]);
  const kindCounts = useMemo<KindCounts>(() => {
    const open = eligible.filter((m) => !hidden.has(m.id));
    return {
      all: open.length,
      movie: open.filter((m) => m.mediaType === 'movie').length,
      tv: open.filter((m) => m.mediaType === 'tv').length,
    };
  }, [eligible, hidden]);
  const hiddenCount = useMemo(
    () => eligible.filter((m) => hidden.has(m.id)).length,
    [eligible, hidden],
  );

  // The suggestion is shown from the LIVE library: a title that was watched, edited or deleted
  // meanwhile is not displayed from a stale copy.
  const live = shown ? movies?.find((m) => m.id === shown.movie.id) : undefined;
  const liveMovie = live && isEligible(live) ? live : null;
  const pick = shown && liveMovie ? { ...shown, movie: liveMovie } : null;
  const pickGone = shown !== null && pick === null;
  const facts = useMemo(
    () => (liveMovie && movies ? pickFacts(liveMovie, movies, clock) : []),
    [liveMovie, movies, clock],
  );

  const recent = useMemo(() => {
    const byId = new Map((movies ?? []).map((m) => [m.id, m] as const));
    const out: Movie[] = [];
    for (const entry of freshHistory(saved.data ?? [], clock)) {
      const movie = byId.get(entry.movieId);
      if (movie?.deletedAt === null && !out.some((m) => m.id === movie.id)) out.push(movie);
      if (out.length === 8) break;
    }
    return out;
  }, [movies, saved.data, clock]);

  return {
    library,
    pick,
    pickGone,
    facts,
    genres,
    genre,
    kind,
    eligibleCount: eligible.length,
    availableCount: pool.length,
    kindCounts,
    hiddenCount,
    recent,
    choose: (next) => {
      setGenre(next);
      roll({ genre: next, kind, hidden });
    },
    chooseKind: (next) => {
      // A genre that has nothing left in the new kind is dropped instead of silently ignored.
      const stillThere =
        genre !== null &&
        inventory(narrow(eligible, { kind: next, hidden })).some(
          (row) => row.genre.toLowerCase() === genre.toLowerCase(),
        );
      const nextGenre = stillThere ? genre : null;
      setKind(next);
      setGenre(nextGenre);
      roll({ genre: nextGenre, kind: next, hidden });
    },
    pickAnother: () => {
      roll({ genre, kind, hidden });
    },
    hide: (movieId) => {
      const now = new Date();
      const current = queryClient.getQueryData<readonly string[]>(snoozeKey) ?? [];
      const nextIds = current.includes(movieId) ? current : [movieId, ...current];
      queryClient.setQueryData(snoozeKey, nextIds);
      if (isCurrent()) {
        void snoozes?.snooze(userId, movieId, new Date(now.getTime() + SNOOZE_DAYS * DAY_MS), now);
      }
      roll({ genre, kind, hidden: new Set(nextIds) });
    },
    showHidden: () => {
      queryClient.setQueryData(snoozeKey, []);
      if (isCurrent()) void snoozes?.clear(userId);
      roll({ genre, kind, hidden: new Set() });
    },
  };
}
