/**
 * Checkbox — boolean toggle with a visible box and label.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import { cn } from '@utils/cn';
import { Icon } from '@components/Icon';
import styles from './Checkbox.module.css';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
  indeterminate?: boolean;
}

function CheckboxInner(
  { label, indeterminate = false, className, disabled, id, checked, ...rest }: CheckboxProps,
  ref: Ref<HTMLInputElement>,
): JSX.Element {
  const autoId = useId();
  const inputId = id ?? autoId;

  // Reflect indeterminate to the DOM so assistive tech announces "mixed"
  // (the minus icon alone is invisible to screen readers). Merge with any
  // forwarded ref so callers still get the input node.
  const innerRef = useRef<HTMLInputElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLInputElement | null) => {
      innerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as { current: HTMLInputElement | null }).current = node;
    },
    [ref],
  );
  useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate, checked]);

  return (
    <label
      className={cn(styles.root, disabled && styles.disabled, className)}
      data-state={indeterminate ? 'indeterminate' : checked ? 'checked' : 'unchecked'}
    >
      <span className={styles.box}>
        <input
          ref={setRefs}
          id={inputId}
          type="checkbox"
          className={styles.input}
          checked={checked}
          disabled={disabled}
          {...rest}
        />
        {indeterminate ? (
          <Icon name="minus" size="sm" className={styles.indicator} />
        ) : checked ? (
          <Icon name="check" size="sm" className={styles.indicator} />
        ) : null}
      </span>
      {label ? <span className={styles.label}>{label}</span> : null}
    </label>
  );
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(CheckboxInner);
Checkbox.displayName = 'Checkbox';
