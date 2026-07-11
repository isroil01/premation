/**
 * SplitPane — two-pane resizable container.
 *
 * <SplitPane direction="horizontal" size={320} min={200} max={480} onResize={...}>
 *   <Pane />
 *   <Pane />
 * </SplitPane>
 *
 * Direction:
 *   - "horizontal" → split is a vertical line; left/right panes, controlled `size` is width of first pane
 *   - "vertical"   → split is a horizontal line; top/bottom panes, `size` is height of first pane
 *
 * Persistence: pass `storageKey` to remember size in localStorage.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@utils/cn';
import { clamp } from '@utils/lang';
import styles from './SplitPane.module.css';

export type SplitDirection = 'horizontal' | 'vertical';

export interface SplitPaneProps {
  direction: SplitDirection;
  /** Initial size in px. If storageKey is set, persisted value wins. */
  defaultSize: number;
  minSize: number;
  maxSize: number;
  /** Optional controlled size. */
  size?: number;
  /** Notified continuously during drag. */
  onResize?: (size: number) => void;
  /** Notified when drag ends. */
  onResizeEnd?: (size: number) => void;
  /** localStorage key for size persistence. */
  storageKey?: string;
  /**
   * Which pane the `size` controls (the fixed pane); the other pane flexes.
   * Use 'last' for right/bottom docks (inspector, timeline) so the primary
   * content pane grows to fill. Defaults to 'first'.
   */
  primary?: 'first' | 'last';
  /** First pane content. */
  children: [ReactNode, ReactNode];
  className?: string;
  /** When true, the primary pane is collapsed (size = 0) and the splitter
   *  is still visible so the user can re-expand by dragging. */
  collapsed?: boolean;
}

function readPersisted(key: string | undefined, fallback: number): number {
  if (!key) return fallback;
  try {
    const raw = window.localStorage.getItem(`splitpane.${key}`);
    if (!raw) return fallback;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  } catch { /* ignore */ }
  return fallback;
}

function writePersisted(key: string | undefined, value: number): void {
  if (!key) return;
  try {
    window.localStorage.setItem(`splitpane.${key}`, String(value));
  } catch { /* ignore */ }
}

export function SplitPane({
  direction,
  defaultSize,
  minSize,
  maxSize,
  size,
  onResize,
  onResizeEnd,
  storageKey,
  primary = 'first',
  children,
  className,
  collapsed = false,
}: SplitPaneProps): JSX.Element {
  const [internal, setInternal] = useState<number>(() => readPersisted(storageKey, defaultSize));
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const startPos = useRef(0);
  const startSize = useRef(0);

  const current = collapsed ? 0 : (size ?? internal);
  // When the fixed pane is the last one, dragging the splitter toward it
  // (increasing pointer coordinate) shrinks it, so invert the delta.
  const sign = primary === 'last' ? -1 : 1;

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;
    startSize.current = current;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [current, direction]);

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      if (!dragging.current) return;
      const pos = direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = pos - startPos.current;
      const next = clamp(startSize.current + sign * delta, minSize, maxSize);
      setInternal(next);
      onResize?.(next);
    };
    const onUp = (e: PointerEvent): void => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const pos = direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = pos - startPos.current;
      const next = clamp(startSize.current + sign * delta, minSize, maxSize);
      writePersisted(storageKey, next);
      onResizeEnd?.(next);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [direction, minSize, maxSize, onResize, onResizeEnd, storageKey, sign]);

  const isH = direction === 'horizontal';
  const fixedStyle = isH
    ? { width: current, minWidth: current, maxWidth: current, flex: 'none' as const }
    : { height: current, minHeight: current, maxHeight: current, flex: 'none' as const };
  const flexStyle = { flex: '1 1 0%', minWidth: 0, minHeight: 0 } as const;
  const firstStyle = primary === 'last' ? flexStyle : fixedStyle;
  const lastStyle = primary === 'last' ? fixedStyle : flexStyle;

  return (
    <div
      ref={containerRef}
      className={cn(styles.root, isH ? styles.horizontal : styles.vertical, className)}
      data-direction={direction}
      data-collapsed={collapsed || undefined}
    >
      <div className={cn(styles.pane, styles.first)} style={firstStyle}>
        {children[0]}
      </div>
      <div
        role="separator"
        aria-orientation={isH ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(current)}
        aria-valuemin={minSize}
        aria-valuemax={maxSize}
        tabIndex={0}
        className={cn(styles.splitter, isH ? styles.splitterH : styles.splitterV)}
        onPointerDown={onPointerDown}
        onKeyDown={(e) => {
          const big = 32, small = 8;
          let delta = 0;
          if (isH) {
            if (e.key === 'ArrowLeft')  delta = -small;
            else if (e.key === 'ArrowRight') delta = small;
            else if (e.key === 'PageUp')    delta = -big;
            else if (e.key === 'PageDown')  delta = big;
            else if (e.key === 'Home')      { setInternal(minSize); writePersisted(storageKey, minSize); e.preventDefault(); return; }
            else if (e.key === 'End')       { setInternal(maxSize); writePersisted(storageKey, maxSize); e.preventDefault(); return; }
          } else {
            if (e.key === 'ArrowUp')    delta = -small;
            else if (e.key === 'ArrowDown')  delta = small;
            else if (e.key === 'PageUp')     delta = -big;
            else if (e.key === 'PageDown')   delta = big;
            else if (e.key === 'Home')       { setInternal(minSize); writePersisted(storageKey, minSize); e.preventDefault(); return; }
            else if (e.key === 'End')        { setInternal(maxSize); writePersisted(storageKey, maxSize); e.preventDefault(); return; }
          }
          if (delta !== 0) {
            e.preventDefault();
            const next = clamp(current + sign * delta, minSize, maxSize);
            setInternal(next);
            writePersisted(storageKey, next);
            onResize?.(next);
            onResizeEnd?.(next);
          }
        }}
      />
      <div className={cn(styles.pane, styles.last)} style={lastStyle}>
        {children[1]}
      </div>
    </div>
  );
}
