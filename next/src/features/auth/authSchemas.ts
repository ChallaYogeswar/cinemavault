import { z } from 'zod';

export const MIN_PASSWORD_LENGTH = 8;

const email = z
  .string()
  .trim()
  .min(1, 'Enter your email address')
  .pipe(z.email('Enter a valid email address'));

export const signInSchema = z.object({
  email,
  // Not length-checked here: an old, shorter password must still be able to sign in.
  password: z.string().min(1, 'Enter your password'),
});

const newPassword = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${String(MIN_PASSWORD_LENGTH)} characters`)
  .max(128, 'That password is too long');

export const signUpSchema = z
  .object({ email, password: newPassword, confirm: z.string() })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'The passwords don’t match',
  });

export const forgotSchema = z.object({ email });

export const resetSchema = z
  .object({ password: newPassword, confirm: z.string() })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'The passwords don’t match',
  });

export type FieldErrors = Readonly<Record<string, string>>;

/** First message per field, so each input shows exactly one clear problem. */
export function fieldErrors(error: z.ZodError): FieldErrors {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    out[key] ??= issue.message;
  }
  return out;
}

/** Where to go after signing in. Only well-known app pages: never a dialog URL, never external. */
const RETURN_TARGETS = ['/', '/library', '/genres', '/discover', '/stats', '/settings'] as const;
export function safeReturnTo(candidate: unknown): string {
  return typeof candidate === 'string' && RETURN_TARGETS.some((target) => target === candidate)
    ? candidate
    : '/library';
}
