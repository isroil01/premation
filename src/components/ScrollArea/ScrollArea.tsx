/**
 * ScrollArea — a scrollable container with consistent themed scrollbars.
 * Wraps native overflow with our token-driven::-webkit-scrollbar styles.
 * Optionally allows both axes to be locked.
 */

import { forwardRef, type HTMLAttributes, type Ref } from 'react';
import { cn } from '@utils/cn';
import styles from './ScrollArea.module.css';

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  /** When true, both axes scroll. */
  bothAxes?: boolean;
  /** Hide the scrollbar until hover. */
  autoHide?: boolean;
}

function ScrollAreaInner(
  { bothAxes = false, autoHide = false, className, children, ...rest }: ScrollAreaProps,
  ref: Ref<HTMLDivElement>,
): JSX.Element {
  return (
    <div
      ref={ref}
      className={cn(
        styles.root,
        bothAxes ? styles.both : styles.primary,
        autoHide && styles.autoHide,
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(ScrollAreaInner);
ScrollArea.displayName = 'ScrollArea';
