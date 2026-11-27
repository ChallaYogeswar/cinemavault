import type { ButtonHTMLAttributes } from 'react';
import { buttonClass, type ButtonVariant } from './buttonStyles';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
}

/** Defaults to type="button" so a button inside a form never submits it by accident. */
export function Button({ variant = 'secondary', className = '', type = 'button', ...rest }: Props) {
  return <button type={type} className={buttonClass(variant, className)} {...rest} />;
}
