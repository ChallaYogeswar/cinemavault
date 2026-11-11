import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { privateKey } from '@/app/privateKey';
import { useRuntime } from '@/app/runtime';
import { useSession } from '@/app/session';
import { Button } from '@/components/ui/Button';
import { DISPLAY_NAME_MAX, parseDisplayName } from '@/domain/profile';
import { AuthField, FormError } from '@/features/auth/AuthField';
import { card } from './cardStyle';

/** The name shown for this account. Hidden in sample-data mode, where there is no profile to edit. */
export function ProfileCard() {
  const { profiles } = useRuntime();
  const { userId, isCurrent } = useSession();
  const queryClient = useQueryClient();
  const key = privateKey(userId, 'display-name');
  const saved = useQuery({
    queryKey: key,
    enabled: profiles !== null,
    queryFn: async () => {
      const result = await profiles?.loadDisplayName(userId);
      if (!result) return null;
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
  });
  // null = the person has not typed yet, so the field shows what is saved.
  const [typed, setTyped] = useState<string | null>(null);
  const draft = typed ?? saved.data ?? '';
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!profiles) return null;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    setNotice(null);
    const parsed = parseDisplayName(draft);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(undefined);
    setBusy(true);
    const result = await profiles.updateDisplayName(userId, parsed.value);
    if (!isCurrent()) return; // the account changed meanwhile: this answer is not for the new one
    setBusy(false);
    if (!result.ok) {
      setFormError(result.error.message);
      return;
    }
    queryClient.setQueryData(key, result.value);
    setTyped(null);
    setNotice(result.value === null ? 'Name removed.' : 'Name saved.');
  };

  return (
    <div className={card}>
      <h2 className="font-serif text-2xl">Profile</h2>
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        className="mt-4 space-y-4"
      >
        <FormError message={formError} />
        {saved.isError ? (
          <p role="alert" className="text-danger text-sm">
            Couldn’t load your saved name. You can still set a new one.
          </p>
        ) : null}
        <AuthField
          id="display-name"
          label="Display name"
          type="text"
          autoComplete="nickname"
          value={draft}
          onChange={(value) => {
            setNotice(null);
            setTyped(value);
          }}
          error={error}
          hint={`Optional, up to ${String(DISPLAY_NAME_MAX)} characters. Leave it empty to remove it.`}
        />
        {notice ? (
          <p role="status" className="text-muted text-sm">
            {notice}
          </p>
        ) : null}
        <Button type="submit" variant="secondary" disabled={busy}>
          {busy ? 'Saving…' : 'Save name'}
        </Button>
      </form>
    </div>
  );
}
