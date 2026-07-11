/**
 * Switch — boolean toggle, visually distinct from a checkbox.
 */

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import { cn } from '@utils/cn';
import styles from './Switch.module.css';

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
}

function SwitchInner(
  { label, className, disabled, id, checked, ...rest }: SwitchProps,
  ref: Ref<HTMLInputElement>,
): JSX.Element {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label
      className={cn(styles.root, disabled && styles.disabled, className)}
      data-state={checked ? 'on' : 'off'}
    >
      <span className={styles.track}>
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          role="switch"
          className={styles.input}
          checked={checked}
          disabled={disabled}
          {...rest}
        />
        <span className={styles.thumb} />
      </span>
      {label ? <span className={styles.label}>{label}</span> : null}
    </label>
  );
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(SwitchInner);
Switch.displayName = 'Switch';
