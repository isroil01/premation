/**
 * FocusBreadcrumb — always-visible location trail (spec: "Main › Scene 2 ›
 * Logo"). Clicking a crumb jumps directly; `Esc` steps up one level. Only
 * shows the chrome when Focus Mode is engaged so the top level stays calm.
 */

import { useEffect } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { useFocusStore, isFocusActive } from '@stores/focusStore';
import { useFocusContext } from './useFocusContext';
import styles from './FocusBreadcrumb.module.css';

export function FocusBreadcrumb(): JSX.Element | null {
  const { active, crumbs } = useFocusContext();
  const jumpTo = useFocusStore((s) => s.jumpTo);
  const exitOne = useFocusStore((s) => s.exitOne);

  // `Esc` steps up one level. Capture + stopPropagation so it beats the global
  // Deselect(Escape) shortcut while Focus Mode is engaged.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const s = useFocusStore.getState();
      if (!isFocusActive(s)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      s.exitOne();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions);
  }, []);

  if (!active) return null;

  return (
    <div className={styles.bar} role="navigation" aria-label="Focus location">
      <Icon name="crosshair" size={12} className={styles.focusIcon} />
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={`${c.index}_${c.label}`} className={styles.crumbWrap}>
            {i > 0 ? <Icon name="chevron-right" size={12} className={styles.sep} /> : null}
            <button
              type="button"
              className={cn(styles.crumb, last && styles.crumbCurrent)}
              disabled={last}
              onClick={() => jumpTo(c.index)}
            >
              {c.label}
            </button>
          </span>
        );
      })}
      <button type="button" className={styles.exit} onClick={() => exitOne()} title="Step up (Esc)">
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

export default FocusBreadcrumb;
