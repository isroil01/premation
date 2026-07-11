/**
 * Input — single-line text input.
 *
 * Supports an inline icon (left/right), a clear button, and a label/help
 * pair. For multi-line, use <TextArea>.
 */

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import { cn } from '@utils/cn';
import { Icon, type IconName } from '@components/Icon';
import type { Size } from '@app-types/common';
import styles from './Input.module.css';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  size?: Size;
  label?: string;
  help?: string;
  error?: string;
  leftIcon?: IconName;
  rightIcon?: IconName;
  clearable?: boolean;
  onClear?: () => void;
  fullWidth?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
}

function InputInner(
  {
    size = 'md',
    label,
    help,
    error,
    leftIcon,
    rightIcon,
    clearable = false,
    onClear,
    fullWidth = false,
    prefix,
    suffix,
    id,
    className,
    value,
    disabled,
    ...rest
  }: InputProps,
  ref: Ref<HTMLInputElement>,
): JSX.Element {
  const autoId = useId();
  const inputId = id ?? autoId;
  const msgId = `${inputId}-msg`;
  const showClear = clearable && value !== '' && value !== undefined && value !== null;

  return (
    <div className={cn(styles.wrap, fullWidth && styles.fullWidth, error && styles.invalid)}>
      {label ? (
        <label htmlFor={inputId} className={styles.label}>
          {label}
        </label>
      ) : null}
      <div
        className={cn(styles.field, styles[`size-${size}`], disabled && styles.disabled)}
        data-size={size}
      >
        {leftIcon ? <Icon name={leftIcon} size={14} className={styles.adornment} /> : null}
        {prefix ? <span className={styles.adornment}>{prefix}</span> : null}
        <input
          ref={ref}
          id={inputId}
          className={cn(styles.input, className)}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || help ? msgId : undefined}
          {...rest}
        />
        {showClear ? (
          <button
            type="button"
            aria-label="Clear"
            className={styles.clear}
            onClick={onClear}
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
        {rightIcon && !showClear ? <Icon name={rightIcon} size={14} className={styles.adornment} /> : null}
        {suffix ? <span className={styles.adornment}>{suffix}</span> : null}
      </div>
      {error ? (
        <div id={msgId} className={styles.error}>{error}</div>
      ) : help ? (
        <div id={msgId} className={styles.help}>{help}</div>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputProps>(InputInner);
Input.displayName = 'Input';
