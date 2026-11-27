import { useState, type SyntheticEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '@/app/auth/auth';
import { Button } from '@/components/ui/Button';
import { AuthField, FormError } from './AuthField';
import { AuthLayout } from './AuthLayout';
import { MIN_PASSWORD_LENGTH, fieldErrors, signUpSchema, type FieldErrors } from './authSchemas';

export function SignUpPage() {
  const { state, actions } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

  if (state.status === 'signed_in') return <Navigate to="/library" replace />;
  if (state.status === 'recovery') return <Navigate to="/reset-password" replace />;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    const parsed = signUpSchema.safeParse({ email, password, confirm });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await actions.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
    });
    setBusy(false);
    if (!result.ok) setFormError(result.error.message);
    else if (result.value.confirmationRequired) setCheckEmail(true);
    // Otherwise the new account is already signed in and the auth state redirects.
  };

  if (checkEmail) {
    return (
      <AuthLayout
        title="Check your email"
        intro="If that address can be used, we’ve sent a link to confirm it. Open it, then sign in."
        footer={
          <Link to="/sign-in" className="text-gold underline underline-offset-4">
            Back to sign in
          </Link>
        }
      >
        <p role="status" className="text-muted text-sm">
          Didn’t get it? Check your spam folder, or try again in a few minutes.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      intro="New accounts can browse the library. Only the owner can change it."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/sign-in" className="text-gold underline underline-offset-4">
            Sign in
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
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          error={errors.password}
          hint={`At least ${String(MIN_PASSWORD_LENGTH)} characters.`}
        />
        <AuthField
          id="confirm"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          error={errors.confirm}
        />
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthLayout>
  );
}
