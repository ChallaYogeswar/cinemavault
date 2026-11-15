import { useState } from 'react';
import { useAuth } from '@/app/auth/auth';
import { useRuntime } from '@/app/runtime';
import { useSession } from '@/app/session';
import { Button } from '@/components/ui/Button';
import type { Role } from '@/domain/permissions';
import { InstallCard } from '@/pwa/InstallCard';
import { loadBackend } from '@/services/env';
import { card } from './cardStyle';
import { DataTransferCard } from './DataTransferCard';
import { DeviceDataCard } from './DeviceDataCard';
import { useOutboxEntries } from '@/features/sync/useOutbox';
import { PasswordCard } from './PasswordCard';
import { ProfileCard } from './ProfileCard';

const ROLES: readonly { value: Role; label: string; hint: string }[] = [
  { value: 'owner', label: 'Owner', hint: 'Can add, edit and delete titles.' },
  { value: 'viewer', label: 'Viewer', hint: 'Can browse only. Every write is refused.' },
];

function DataSourceCard() {
  const runtime = useRuntime();
  const backend = loadBackend();
  return (
    <div className={card}>
      <h2 className="font-serif text-2xl">Data</h2>
      {runtime.kind === 'mock' ? (
        <p role="status" className="text-muted mt-3 text-sm">
          Running on <b className="text-text">sample data</b>. Nothing here is connected to a real
          library.
        </p>
      ) : backend.kind === 'supabase' ? (
        <p role="status" className="text-muted mt-3 text-sm">
          Connected to <b className="text-text">{backend.config.appEnv}</b> ·{' '}
          {new URL(backend.config.supabaseUrl).host}
        </p>
      ) : null}
    </div>
  );
}

function AccountCard() {
  const session = useSession();
  const runtime = useRuntime();
  const { actions } = useAuth();
  const [busy, setBusy] = useState<'here' | 'everywhere' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'here' | 'everywhere' | null>(null);
  const unsent = useOutboxEntries().length;

  const leave = (scope: 'here' | 'everywhere') => {
    setConfirming(null);
    setBusy(scope);
    const run = scope === 'here' ? actions.signOut() : actions.signOutEverywhere();
    void run.then((result) => {
      // The device is signed out either way; say so if the server could not be told.
      if (!result.ok)
        setProblem(
          scope === 'here'
            ? 'Signed out on this device. We couldn’t reach the server to end the session everywhere.'
            : 'Signed out on this device, but we couldn’t reach the server to sign out your other devices. Try again when you’re online.',
        );
      setBusy(null);
    });
  };

  return (
    <div className={card}>
      <h2 className="font-serif text-2xl">Account</h2>
      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex flex-wrap gap-x-3">
          <dt className="text-muted">Signed in as</dt>
          <dd className="break-all">{session.email ?? 'unknown email'}</dd>
        </div>
        <div className="flex flex-wrap gap-x-3">
          <dt className="text-muted">Access</dt>
          <dd>
            {session.role === 'owner' ? 'Owner — can change the library' : 'Viewer — view only'}
            {session.roleVerified
              ? ''
              : session.roleFromDevice
                ? ' (as last confirmed on this device)'
                : ' (not verified)'}
          </dd>
        </div>
      </dl>
      {session.roleVerified ? null : session.roleFromDevice ? (
        <p role="status" className="text-muted mt-3 text-sm">
          You’re offline, so this is the access your device last confirmed. Changes you make are
          kept here and checked by the server when you reconnect.
        </p>
      ) : (
        <p role="status" className="text-muted mt-3 text-sm">
          We couldn’t confirm your access just now, so the app is treating you as a viewer. Your
          library is safe; editing returns once this is confirmed.
        </p>
      )}
      {problem ? (
        <p role="alert" className="text-danger mt-3 text-sm">
          {problem}
        </p>
      ) : null}
      {confirming ? (
        <div
          role="alertdialog"
          aria-labelledby="unsent-title"
          className="border-danger/40 mt-4 rounded-2xl border p-4"
        >
          <p id="unsent-title" className="font-semibold">
            {unsent === 1
              ? '1 change has not reached the server.'
              : `${String(unsent)} changes have not reached the server.`}
          </p>
          <p className="text-muted mt-1 text-sm">
            They are kept only on this device. Signing out deletes them for good. Go online and let
            them sync first, or sign out anyway and lose them.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => {
                setConfirming(null);
              }}
            >
              Stay signed in
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                leave(confirming);
              }}
            >
              Sign out and discard them
            </Button>
          </div>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {runtime.kind === 'supabase' ? (
          <Button variant="secondary" onClick={session.retryRole}>
            Refresh permissions
          </Button>
        ) : null}
        <Button
          variant="secondary"
          disabled={busy !== null}
          onClick={() => {
            if (unsent > 0) setConfirming('here');
            else leave('here');
          }}
        >
          {busy === 'here' ? 'Signing out…' : 'Sign out'}
        </Button>
        {runtime.kind === 'supabase' ? (
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => {
              if (unsent > 0) setConfirming('everywhere');
              else leave('everywhere');
            }}
          >
            {busy === 'everywhere' ? 'Signing out…' : 'Sign out of all devices'}
          </Button>
        ) : null}
      </div>
      {runtime.kind === 'supabase' ? (
        <p className="text-dim mt-3 text-xs">
          “Sign out of all devices” ends every session of this account, including other browsers and
          installed copies. They are signed out the next time they connect.
        </p>
      ) : null}
    </div>
  );
}

/** Sample-data mode only: lets a reviewer see what a friend (viewer) would see, or swap accounts. */
function PreviewControls() {
  const { mock } = useAuth();
  const session = useSession();
  if (!mock) return null;
  return (
    <div className={card}>
      <h2 className="font-serif text-2xl">Preview controls</h2>
      <p className="text-muted mt-2 text-sm">
        Sample-data mode only. Switch role to check what a friend would see, or switch account to
        confirm each account’s data stays separate.
      </p>
      <fieldset className="mt-4 space-y-2">
        <legend className="sr-only">Preview role</legend>
        {ROLES.map((role) => (
          <label
            key={role.value}
            className="border-line has-[:checked]:border-gold flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border p-3"
          >
            <input
              type="radio"
              name="preview-role"
              className="accent-gold mt-1 size-4"
              checked={session.role === role.value}
              onChange={() => {
                mock.setRole(role.value);
              }}
            />
            <span>
              <span className="block text-sm font-semibold">{role.label}</span>
              <span className="text-muted block text-xs">{role.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="text-dim mt-4 font-mono text-xs break-all">{session.userId}</p>
      <Button
        className="mt-3"
        variant="secondary"
        onClick={() => {
          mock.switchAccount(crypto.randomUUID());
        }}
      >
        Switch to a different account
      </Button>
    </div>
  );
}

export function SettingsPage() {
  return (
    <section>
      <p className="text-gold mb-4 font-mono text-[11px] uppercase tracking-[0.22em]">Settings</p>
      <h1 className="font-serif text-4xl font-semibold tracking-[-0.05em] sm:text-6xl">
        Keep the vault yours.
      </h1>
      <DataSourceCard />
      <InstallCard />
      <AccountCard />
      <ProfileCard />
      <PasswordCard />
      <DataTransferCard />
      <DeviceDataCard />
      <PreviewControls />
    </section>
  );
}
