/**
 * Button — primary interactive control in the design system.
 *
 * Variants: primary | secondary | ghost | tertiary | danger
 * Sizes:    xs | sm | md | lg
 *
 * Behaviour:
 *   - Disabled state is visible and removes pointer events.
 *   - Loading state replaces label with a spinner.
 *   - `as` prop allows polymorphic root (button | a).
 *   - Forwards ref for parent focus management.
 */

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import { cn } from '@utils/cn';
import type { Size, Variant } from '@app-types/common';
import styles from './Button.module.css';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  type?: 'button' | 'submit' | 'reset';
}

import { usePreferenceStore } from '@stores/preferenceStore';

function ButtonInner(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    fullWidth = false,
    leftIcon,
    rightIcon,
    disabled,
    className,
    style,
    children,
    type = 'button',
    ...rest
  }: ButtonProps,
  ref: Ref<HTMLButtonElement>,
): JSX.Element {
  const buttonPref = usePreferenceStore((s) => s.buttonSize);
  const scaleMult = buttonPref === 'sm' ? 0.88 : buttonPref === 'lg' ? 1.15 : 1.0;
  const mergedStyle = scaleMult !== 1 ? { transform: `scale(${scaleMult})`, transformOrigin: 'center center', ...style } : style;

  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      data-variant={variant}
      data-size={size}
      style={mergedStyle}
      className={cn(
        styles.root,
        fullWidth && styles.fullWidth,
        loading && styles.loading,
        className,
      )}
      {...rest}
    >
      {leftIcon ? <span className={styles.icon}>{leftIcon}</span> : null}
      <span className={styles.label}>{children}</span>
      {rightIcon ? <span className={styles.icon}>{rightIcon}</span> : null}
      {loading ? <span className={styles.spinner} aria-hidden /> : null}
    </button>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(ButtonInner);
Button.displayName = 'Button';
