/**
 * Shown instead of the app when the build's configuration is unusable. The app never falls back to
 * sample data here: a production site showing fake titles would be worse than an honest error.
 */
export function ConfigurationError({ problems }: { readonly problems: readonly string[] }) {
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div role="alert" className="border-danger/40 bg-danger/5 max-w-lg rounded-[28px] border p-8">
        <h1 className="font-serif text-3xl font-semibold tracking-tight">
          CinemaVault isn’t configured
        </h1>
        <ul className="text-muted mt-4 list-disc space-y-1 pl-5 text-sm">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
        <p className="text-dim mt-4 text-xs">
          Copy .env.example to .env.local and fill in your DEVELOPMENT Supabase project.
        </p>
      </div>
    </main>
  );
}
