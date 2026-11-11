import { useState, type SyntheticEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/app/auth/auth';
import { Button } from '@/components/ui/Button';
import { AuthField, FormError } from './AuthField';
import { AuthLayout } from './AuthLayout';
import { fieldErrors, safeReturnTo, signInSchema, type FieldErrors } from './authSchemas';

export function SignInPage() {
  const { state, actions, mock } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.status === 'signed_in') {
    const from = (location.state as { from?: unknown } | null)?.from;
    return <Navigate to={safeReturnTo(from)} replace />;
  }
  if (state.status === 'recovery') return <Navigate to="/reset-password" replace />;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    const parsed = signInSchema.safeParse({ email, password });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await actions.signIn(parsed.data);
    setBusy(false);
    if (!result.ok) setFormError(result.error.message);
    // On success the auth state changes and this page redirects; nothing else to do here.
  };

  return (
    <AuthLayout
      title="Sign in"
      {...(mock ? { intro: 'Preview mode: any email and password opens the sample library.' } : {})}
      footer={
        <>
          New here?{' '}
          <Link to="/sign-up" className="text-gold underline underline-offset-4">
            Create an account
          </Link>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        className="space-y-4"
      >
        <FormError message={formError} />
        <AuthField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          error={errors.email}
        />
        <AuthField
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          error={errors.password}
        />
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <p className="text-center text-sm">
          <Link
            to="/forgot-password"
            className="text-muted hover:text-text underline underline-offset-4"
          >
            Forgot your password?
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
