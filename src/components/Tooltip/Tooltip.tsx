/**
 * Tooltip — a fast, styled floating label, built on Radix Tooltip (accessible,
 * portalled, collision-aware). Wrap any focusable element:
 *
 *   <Tooltip label="Play">{trigger}</Tooltip>
 *
 * A single <TooltipProvider> must sit near the app root (see Providers).
 */

import * as RTooltip from '@radix-ui/react-tooltip';
import { type ReactElement, type ReactNode } from 'react';
import styles from './Tooltip.module.css';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  label: ReactNode;
  placement?: TooltipPlacement;
  /** The trigger element. */
  children: ReactElement;
  className?: string;
}

/** One provider near the app root controls delay/skip behaviour for all tooltips. */
export function TooltipProvider({ children }: { children: ReactNode }): JSX.Element {
  return (
    <RTooltip.Provider delayDuration={320} skipDelayDuration={240}>
      {children}
    </RTooltip.Provider>
  );
}

export function Tooltip({ label, placement = 'top', children, className }: TooltipProps): ReactElement {
  if (label === null || label === undefined || label === '') return children;
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          className={className ? `${styles.pop} ${className}` : styles.pop}
          side={placement}
          sideOffset={6}
          collisionPadding={8}
        >
          {label}
          <RTooltip.Arrow className={styles.arrow} />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
