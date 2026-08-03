/**
 * StatusBar — bottom strip for app-wide status indicators.
 *
 * Slots: left, center, right, each taking arbitrary content (chips, text, small
 * buttons). Purely a layout shell; App.tsx fills all three with live state —
 * dirty indicator, layer and selection counts, playhead, zoom.
 *
 * (The previous docstring said the timeline engine "will push" that content in,
 * future tense, long after it had.)
 */

import type { ReactNode } from 'react';
import { cn } from '@utils/cn';
import styles from './StatusBar.module.css';

export interface StatusBarProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  className?: string;
}

export function StatusBar({ left, center, right, className }: StatusBarProps): JSX.Element {
  return (
    <footer className={cn(styles.root, className)} role="status">
      <div className={cn(styles.group, styles.left)}>{left}</div>
      <div className={cn(styles.group, styles.center)}>{center}</div>
      <div className={cn(styles.group, styles.right)}>{right}</div>
    </footer>
  );
}
