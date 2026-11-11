import { z } from 'zod';

const APP_ENVS = ['development', 'preview', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Names that must never be exposed to the browser. Vite ships every VITE_* variable to visitors. */
const FORBIDDEN_CLIENT_VARS = /service[_-]?role|secret|private|password|tmdb/i;

/** True when the value looks like a Supabase secret/service-role credential. */
function looksLikeServiceCredential(value: string): boolean {
  if (value.startsWith('sb_secret_')) return true;
  const parts = value.split('.');
  if (parts.length === 3 && parts[1]) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
        role?: unknown;
      };
      return payload.role === 'service_role';
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Project refs of PRODUCTION Supabase databases. A development or preview build must never be
 * pointed at one of these: milestone M3 is developed and rehearsed on a separate project.
 */
export const PRODUCTION_PROJECT_REFS: readonly string[] = ['qhopjfqpnmoinggejgvt'];

/** The project ref is the first label of `<ref>.supabase.co`. */
export const projectRefOf = (url: string): string => new URL(url).hostname.split('.')[0] ?? '';

const envSchema = z.object({
  VITE_SUPABASE_URL: z
    .url('VITE_SUPABASE_URL must be a URL')
    .refine(
      (u) => u.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(u),
      {
        message: 'VITE_SUPABASE_URL must use https (http is allowed only for localhost)',
      },
    ),
  VITE_SUPABASE_PUBLISHABLE_KEY: z
    .string()
    .min(20, 'VITE_SUPABASE_PUBLISHABLE_KEY looks too short')
    .refine((k) => !looksLikeServiceCredential(k), {
      message:
        'VITE_SUPABASE_PUBLISHABLE_KEY looks like a service-role/secret key. Use the publishable (anon) key only.',
    }),
  VITE_APP_ENV: z.enum(APP_ENVS).default('development'),
});

export type DataSource = 'supabase' | 'mock';

export interface AppConfig {
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
  readonly appEnv: AppEnv;
}

export type EnvResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Pure and testable: pass any record (import.meta.env in the app, a literal in tests). */
export function parseEnv(raw: Record<string, unknown>): EnvResult {
  const problems: string[] = [];

  for (const key of Object.keys(raw)) {
    if (key.startsWith('VITE_') && FORBIDDEN_CLIENT_VARS.test(key)) {
      problems.push(
        `${key}: secrets must never use the VITE_ prefix (it is bundled into the browser).`,
      );
    }
  }

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`${issue.path.join('.') || 'env'}: ${issue.message}`);
    }
  }

  if (parsed.success) {
    const ref = projectRefOf(parsed.data.VITE_SUPABASE_URL);
    if (parsed.data.VITE_APP_ENV !== 'production' && PRODUCTION_PROJECT_REFS.includes(ref)) {
      problems.push(
        `VITE_SUPABASE_URL points at the PRODUCTION database (${ref}) but VITE_APP_ENV is "${parsed.data.VITE_APP_ENV}". Use a separate development project or branch.`,
      );
    }
  }

  if (problems.length > 0 || !parsed.success) return { ok: false, problems };

  return {
    ok: true,
    config: {
      supabaseUrl: parsed.data.VITE_SUPABASE_URL,
      supabasePublishableKey: parsed.data.VITE_SUPABASE_PUBLISHABLE_KEY,
      appEnv: parsed.data.VITE_APP_ENV,
    },
  };
}

/** The environment this build was compiled with. */
export function loadEnv(): EnvResult {
  return parseEnv(import.meta.env);
}

export type Backend =
  | { readonly kind: 'supabase'; readonly config: AppConfig }
  | { readonly kind: 'mock'; readonly reason: string }
  | { readonly kind: 'misconfigured'; readonly problems: readonly string[] };

/**
 * Decides where data comes from, and NEVER silently substitutes sample data for a real backend:
 *  - mock data is used only when explicitly requested (VITE_DATA_SOURCE=mock) or when the dev
 *    server (mode "development") has no Supabase configuration at all;
 *  - a production build with missing or invalid configuration is reported, not papered over;
 *  - mock data is refused outright when VITE_APP_ENV is "production".
 * `mode` is Vite's build mode ("development" for the dev server, "production" for a build).
 */
export function resolveBackend(raw: Record<string, unknown>, mode: string): Backend {
  const source = raw.VITE_DATA_SOURCE;
  if (source !== undefined && source !== '' && source !== 'supabase' && source !== 'mock') {
    return {
      kind: 'misconfigured',
      problems: ['VITE_DATA_SOURCE must be "supabase" or "mock" (or left unset).'],
    };
  }
  const appEnv =
    raw.VITE_APP_ENV === undefined || raw.VITE_APP_ENV === '' ? 'development' : raw.VITE_APP_ENV;

  if (source === 'mock') {
    return appEnv === 'production'
      ? {
          kind: 'misconfigured',
          problems: ['Sample (mock) data is not allowed when VITE_APP_ENV is "production".'],
        }
      : { kind: 'mock', reason: 'VITE_DATA_SOURCE=mock' };
  }

  const env = parseEnv(raw);
  if (env.ok) return { kind: 'supabase', config: env.config };

  const unset = source === undefined || source === '';
  if (unset && mode === 'development' && appEnv !== 'production') {
    const nothingConfigured =
      raw.VITE_SUPABASE_URL === undefined && raw.VITE_SUPABASE_PUBLISHABLE_KEY === undefined;
    if (nothingConfigured) {
      return { kind: 'mock', reason: 'no Supabase configuration found (dev server only)' };
    }
  }
  return { kind: 'misconfigured', problems: env.problems };
}

export const loadBackend = (): Backend => resolveBackend(import.meta.env, import.meta.env.MODE);
