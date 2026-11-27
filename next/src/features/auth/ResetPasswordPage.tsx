import { useState, type SyntheticEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '@/app/auth/auth';
import { Button } from '@/components/ui/Button';
import { AuthField, FormError } from './AuthField';
import { AuthLayout } from './AuthLayout';
import { MIN_PASSWORD_LENGTH, fieldErrors, resetSchema, type FieldErrors } from './authSchemas';

export function ResetPasswordPage() {
  const { state, actions } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.status === 'loading') return null;
  if (state.status === 'signed_in') return <Navigate to="/library" replace />;
  if (state.status === 'signed_out') {
    return (
      <AuthLayout
        title="This link has expired"
        intro="Reset links work once and for a short time. Request a new one to continue."
        footer={
          <Link to="/sign-in" className="text-gold underline underline-offset-4">
            Back to sign in
          </Link>
        }
      >
        <Link to="/forgot-password" className="text-gold underline underline-offset-4">
          Send me a new link
        </Link>
      </AuthLayout>
    );
  }

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    const parsed = resetSchema.safeParse({ password, confirm });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await actions.updatePassword(parsed.data.password);
    setBusy(false);
    if (!result.ok) setFormError(result.error.message);
    // On success the account is signed in and this page redirects to the library.
  };

  return (
    <AuthLayout title="Choose a new password" intro={`For ${state.user.email ?? 'your account'}.`}>
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        className="space-y-4"
      >
        <FormError message={formError} />
        <AuthField
          id="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          error={errors.password}
          hint={`At least ${String(MIN_PASSWORD_LENGTH)} characters.`}
        />
        <AuthField
          id="confirm"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          error={errors.confirm}
        />
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Save password'}
        </Button>
      </form>
    </AuthLayout>
  );
}
