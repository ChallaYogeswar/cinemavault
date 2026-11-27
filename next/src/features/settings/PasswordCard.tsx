import { useState, type SyntheticEvent } from 'react';
import { useAuth } from '@/app/auth/auth';
import { useRuntime } from '@/app/runtime';
import { useSession } from '@/app/session';
import { Button } from '@/components/ui/Button';
import { AuthField, FormError } from '@/features/auth/AuthField';
import {
  MIN_PASSWORD_LENGTH,
  fieldErrors,
  resetSchema,
  type FieldErrors,
} from '@/features/auth/authSchemas';
import { card } from './cardStyle';

/** Change the password, or have a reset link emailed. Not offered on sample data (nothing to change). */
export function PasswordCard() {
  const runtime = useRuntime();
  const { email, isCurrent } = useSession();
  const { actions } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);

  if (runtime.kind !== 'supabase') return null;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    setNotice(null);
    const parsed = resetSchema.safeParse({ password, confirm });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await actions.updatePassword(parsed.data.password);
    if (!isCurrent()) return;
    setBusy(false);
    if (!result.ok) {
      setFormError(result.error.message);
      return;
    }
    setPassword('');
    setConfirm('');
    setNotice('Password changed.');
  };

  const sendLink = async () => {
    if (!email) return;
    setFormError(null);
    setNotice(null);
    setLinkBusy(true);
    const result = await actions.requestPasswordReset(email);
    if (!isCurrent()) return;
    setLinkBusy(false);
    if (!result.ok) setFormError(result.error.message);
    else setNotice(`If ${email} can receive mail, a reset link is on its way.`);
  };

  return (
    <div className={card}>
      <h2 className="font-serif text-2xl">Password</h2>
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        className="mt-4 space-y-4"
      >
        <FormError message={formError} />
        <AuthField
          id="new-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          error={errors.password}
          hint={`At least ${String(MIN_PASSWORD_LENGTH)} characters.`}
        />
        <AuthField
          id="confirm-new-password"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          error={errors.confirm}
        />
        {notice ? (
          <p role="status" className="text-muted text-sm">
            {notice}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="secondary" disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </Button>
          {email ? (
            <Button
              variant="ghost"
              disabled={linkBusy}
              onClick={() => {
                void sendLink();
              }}
            >
              {linkBusy ? 'Sending…' : 'Email me a reset link instead'}
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
