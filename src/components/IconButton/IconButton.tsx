/**
 * IconButton — square button containing a single icon.
 * Use anywhere a button doesn't need a visible label.
 */

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import { cn } from '@utils/cn';
import { Tooltip } from '@components/Tooltip';
import type { Size, Variant } from '@app-types/common';
import styles from './IconButton.module.css';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Required for accessibility — read by screen readers and shown in tooltip. */
  'aria-label': string;
  variant?: Variant;
  size?: Size;
  active?: boolean;
  children: ReactNode;
  tooltip?: string;
  type?: 'button' | 'submit' | 'reset';
}

import { usePreferenceStore } from '@stores/preferenceStore';

function IconButtonInner(
  {
    variant = 'ghost',
    size = 'md',
    active = false,
    className,
    style,
    children,
    disabled,
    type = 'button',
    tooltip,
    title,
    'aria-label': ariaLabel,
    ...rest
  }: IconButtonProps,
  ref: Ref<HTMLButtonElement>,
): JSX.Element {
  const buttonPref = usePreferenceStore((s) => s.buttonSize);
  const scaleMult = buttonPref === 'sm' ? 0.88 : buttonPref === 'lg' ? 1.15 : 1.0;
  const mergedStyle = scaleMult !== 1 ? { transform: `scale(${scaleMult})`, transformOrigin: 'center center', ...style } : style;

  // Every icon-only button gets a styled Radix tooltip: explicit `tooltip`,
  // else legacy `title`, else the (required) accessible label. The native
  // `title` is dropped so the browser's own tooltip never doubles up.
  const label = tooltip ?? title ?? ariaLabel;
  const btn = (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-label={ariaLabel}
      data-variant={variant}
      data-size={size}
      data-active={active || undefined}
      style={mergedStyle}
      className={cn(styles.root, className)}
      {...rest}
    >
      {children}
    </button>
  );
  return label ? <Tooltip label={label}>{btn}</Tooltip> : btn;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(IconButtonInner);
IconButton.displayName = 'IconButton';
