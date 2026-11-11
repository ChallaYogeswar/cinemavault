import { useState, type SyntheticEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '@/app/auth/auth';
import { Button } from '@/components/ui/Button';
import { AuthField, FormError } from './AuthField';
import { AuthLayout } from './AuthLayout';
import { fieldErrors, forgotSchema, type FieldErrors } from './authSchemas';

export function ForgotPasswordPage() {
  const { state, actions } = useAuth();
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  if (state.status === 'signed_in') return <Navigate to="/library" replace />;
  if (state.status === 'recovery') return <Navigate to="/reset-password" replace />;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    const parsed = forgotSchema.safeParse({ email });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await actions.requestPasswordReset(parsed.data.email);
    setBusy(false);
    if (result.ok) setSent(true);
    else setFormError(result.error.message);
  };

  return (
    <AuthLayout
      title="Reset your password"
      intro="Enter your email and we’ll send a link to choose a new password."
      footer={
        <Link to="/sign-in" className="text-gold underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        // Same message whether or not the address has an account.
        <p role="status" className="text-muted text-sm leading-relaxed">
          If an account exists for that address, a reset link is on its way. It can take a few
          minutes to arrive.
        </p>
      ) : (
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
          <Button type="submit" variant="primary" className="w-full" disabled={busy}>
            {busy ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
