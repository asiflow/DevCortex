'use client';

import type { ComponentProps, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends Omit<ComponentProps<'button'>, 'className'> {
  variant?: ButtonVariant;
  children: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn btn-primary',
  secondary: 'btn btn-secondary',
  ghost: 'btn btn-ghost',
};

export function Button({ variant = 'primary', type = 'button', children, ...rest }: ButtonProps): React.JSX.Element {
  return (
    <button type={type} className={VARIANT_CLASS[variant]} {...rest}>
      {children}
    </button>
  );
}
