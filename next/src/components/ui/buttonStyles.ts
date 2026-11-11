export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50 min-h-11 px-5 text-sm';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-gold text-bg hover:bg-[#ecc67a]',
  secondary: 'border border-line bg-surface-2 text-text hover:bg-surface-3',
  ghost: 'text-muted hover:text-text',
  danger: 'bg-danger text-bg hover:bg-[#ea7f78]',
};

/** Shared by <Button> and by <Link> elements that should look like buttons. */
export const buttonClass = (variant: ButtonVariant = 'secondary', extra = ''): string =>
  `${BASE} ${VARIANTS[variant]} ${extra}`.trim();
