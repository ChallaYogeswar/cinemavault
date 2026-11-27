import { Link } from 'react-router-dom';
import { buttonClass } from '@/components/ui/buttonStyles';
import { isEligible } from '@/domain/recommend';
import { useMoviesQuery } from '@/features/library/queries';

/** The home screen. Counting the backlog reads the library only; it never records a suggestion. */
export function HomePage() {
  const library = useMoviesQuery();
  const movies = library.data;
  const waiting = movies?.filter(isEligible).length ?? null;

  return (
    <section className="cv-fade">
      <p className="text-gold mb-4 font-mono text-[11px] uppercase tracking-[0.22em]">
        CinemaVault Next
      </p>
      <h1 className="font-serif text-5xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-7xl">
        Your cinema, <em className="text-[#cfc5b1]">rebuilt.</em>
      </h1>
      <p className="text-muted mt-6 max-w-xl text-base leading-relaxed sm:text-lg">
        {movies === undefined
          ? 'Your library, your picks, your pace.'
          : movies.length === 0
            ? 'Your vault is empty. Add the first title to get started.'
            : `${String(movies.length)} ${movies.length === 1 ? 'title' : 'titles'} in your vault${
                waiting === null || waiting === 0
                  ? '.'
                  : `, ${String(waiting)} waiting to be watched.`
              }`}
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link to="/library" className={buttonClass('primary')}>
          Open the library
        </Link>
        {waiting !== null && waiting > 0 ? (
          <Link to="/discover" className={buttonClass('secondary')}>
            What should I watch tonight?
          </Link>
        ) : null}
      </div>
    </section>
  );
}
