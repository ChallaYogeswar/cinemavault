/**
 * Where unexpected errors go. This is only the HOOK: nothing is sent anywhere unless someone
 * registers a sink with `setErrorSink` (for example one that posts to a reporting service whose host
 * has also been added to `connect-src` in security/policy.mjs). Until then reports go nowhere except
 * the developer console in a development build.
 *
 * What a report may contain is decided HERE, not by the sink: a library is personal data, so a
 * report carries the error's kind, a scrubbed message and stack, which screen it happened on (ids
 * and query strings removed) and when. It never carries titles, ratings, notes, search text, e-mail
 * addresses, ids, tokens, or anything read from storage.
 */
export type ErrorSource = 'render' | 'route' | 'window' | 'promise';

export interface ErrorReport {
  readonly source: ErrorSource;
  readonly name: string;
  readonly message: string;
  readonly stack: string;
  /** Path only, with ids replaced: `/library/[id]/edit`. */
  readonly screen: string;
  readonly at: string;
}

export type ErrorSink = (report: ErrorReport) => void;

const MAX_MESSAGE = 300;
const MAX_STACK = 2000;
/** Per page load: a render loop must not become a flood. */
export const MAX_REPORTS = 20;
const SAME_ERROR_WITHIN_MS = 10_000;

let sink: ErrorSink | null = null;
let sent = 0;
const recent = new Map<string, number>();

export function setErrorSink(next: ErrorSink | null): void {
  sink = next;
}

/** Test hook: forget what was already reported. */
export function resetErrorReporting(): void {
  sent = 0;
  recent.clear();
}

/** Removes the kinds of text that identify a person or grant access. Order matters (token first). */
export function scrub(text: string): string {
  return (
    text
      .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[token]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [token]')
      .replace(/[^\s@<>()'"]+@[^\s@<>()'"]+\.[^\s@<>()'"]+/g, '[email]')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
      // Anything after ? or # in a URL: search text, auth codes and recovery tokens live there.
      .replace(/\?[^\s#)'"]*/g, '?[query]')
      .replace(/#[^\s)'"]*/g, '#[hash]')
  );
}

export function screenOf(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? '/';
  return scrub(path)
    .replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, '/[id]')
    .slice(0, 120);
}

export function toReport(error: unknown, source: ErrorSource, pathname: string): ErrorReport {
  const real = error instanceof Error;
  return {
    source,
    name: real ? error.name.slice(0, 60) : 'NonError',
    // A thrown string or object may be user data; only a real Error's message is trusted to be code's.
    message: real ? scrub(error.message).slice(0, MAX_MESSAGE) : 'A non-error value was thrown.',
    stack: real && error.stack ? scrub(error.stack).slice(0, MAX_STACK) : '',
    screen: screenOf(pathname),
    at: new Date().toISOString(),
  };
}

/** Reports an error. Never throws, never reports the same error twice in a row, never floods. */
export function reportError(error: unknown, source: ErrorSource): void {
  try {
    if (sent >= MAX_REPORTS) return;
    const pathname = typeof window === 'undefined' ? '/' : window.location.pathname;
    const report = toReport(error, source, pathname);
    const key = `${report.source}|${report.name}|${report.message}`;
    const now = Date.now();
    const last = recent.get(key);
    if (last !== undefined && now - last < SAME_ERROR_WITHIN_MS) return;
    recent.set(key, now);
    if (recent.size > 50) {
      const oldest = recent.keys().next();
      if (!oldest.done) recent.delete(oldest.value);
    }
    sent += 1;
    if (import.meta.env.DEV) console.error('[error report]', report);
    sink?.(report);
  } catch {
    // Reporting must never be the thing that breaks the app.
  }
}

/** Catches what no component caught. Returns a function that removes the handlers. */
export function installGlobalErrorHandlers(target: EventTarget = window): () => void {
  const onError = (event: Event): void => {
    // A failed image/script load is a resource event with no `error`; those are not code bugs.
    const error: unknown = event instanceof ErrorEvent ? event.error : undefined;
    if (error === undefined || error === null) return;
    reportError(error, 'window');
  };
  const onRejection = (event: Event): void => {
    reportError((event as Event & { readonly reason?: unknown }).reason, 'promise');
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
