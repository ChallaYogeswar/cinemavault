import { Link, useRouteError } from 'react-router-dom';
import { buttonClass } from '@/components/ui/buttonStyles';
import { Button } from '@/components/ui/Button';
import { isChunkLoadError } from './chunkError';

/**
 * What a person sees instead of a blank page when a screen fails to draw or to load. It names no
 * technical detail (that goes to the console) and always offers a way forward.
 */
export function RouteError() {
  const error = useRouteError();
  // Reported to the developer console only; the page stays calm and free of internals.
  console.error('Screen failed', error);
  const loading = isChunkLoadError(error);
  return (
    <section
      role="alert"
      className="border-danger/40 bg-danger/5 mx-auto mt-10 max-w-xl rounded-[28px] border px-6 py-12 text-center"
    >
      <h1 className="font-serif text-2xl font-semibold tracking-tight sm:text-3xl">
        {loading ? 'This page couldn’t be loaded' : 'Something went wrong on this page'}
      </h1>
      <p className="text-muted mx-auto mt-3 max-w-md text-sm leading-relaxed sm:text-base">
        {loading
          ? 'Part of the app didn’t download. If you’re offline, reconnect or open a page you’ve already visited. Otherwise reload to get the latest version.'
          : 'Your library is safe. Reloading usually fixes it; if it keeps happening, go back to the home page.'}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload
        </Button>
        <Link to="/" className={buttonClass('ghost')}>
          Go to home
        </Link>
      </div>
    </section>
  );
}
