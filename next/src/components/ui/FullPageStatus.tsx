export function FullPageStatus({ label }: { readonly label: string }) {
  return (
    <div role="status" aria-live="polite" className="grid min-h-screen place-items-center px-6">
      <p className="text-muted font-mono text-xs uppercase tracking-[0.22em]">{label}</p>
    </div>
  );
}
