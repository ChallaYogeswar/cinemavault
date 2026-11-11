interface Props {
  readonly eyebrow: string;
  readonly title: string;
  readonly milestone: string;
}

export function SectionPlaceholder({ eyebrow, title, milestone }: Props) {
  return (
    <section>
      <p className="text-gold mb-4 font-mono text-[11px] uppercase tracking-[0.22em]">{eyebrow}</p>
      <h1 className="font-serif text-4xl font-semibold tracking-[-0.05em] sm:text-6xl">{title}</h1>
      <p className="text-muted mt-5 max-w-lg">
        {milestone === '—'
          ? 'Check the address, or head back home.'
          : 'Not built yet — this screen arrives in a later milestone.'}
      </p>
    </section>
  );
}
