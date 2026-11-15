import { z } from 'zod';

/**
 * Must be the FIRST import of `main.tsx`: it runs before any schema is built.
 *
 * Zod's fast path compiles a validator with `new Function(...)`. Our Content-Security-Policy does
 * not allow `eval` (so an injected string can never become code), and a strict policy reports even
 * the probe as a violation. Turning the fast path off keeps validation identical and the policy
 * strict; it costs a little speed on large lists (measured by `npm run perf`).
 */
z.config({ jitless: true });
