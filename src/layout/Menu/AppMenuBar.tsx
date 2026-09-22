/**
 * AppMenuBar — the classic desktop menu bar (File / Edit / Composition / Layer /
 * Effect / Animation / View / Window / Plugins / Help — the static groups come
 * from APP_MENU in menuModel, Plugins is built per render from what is
 * installed; see useAppMenuGroups).
 *
 * There is no Examples group. Demo scenes used to replace the open document
 * from the command palette; that path is gone.
 *
 * Purely a renderer over the menu model + CommandRegistry: labels, enabled
 * state and shortcuts come from the registered commands, activation goes
 * through the CommandSystem. Hovering between open groups switches menus, as
 * in a native menu bar.
 *
 * KEYBOARD (WAI-ARIA menubar pattern). One group button is in the tab order
 * at a time (roving tabindex); Left/Right move between groups — and, while a
 * menu is open, switch which menu is open; Down/Enter/Space open the focused
 * group; Escape closes and returns focus to the group button. Left/Right
 * inside an open menu are forwarded here from a window capture listener,
 * except on a submenu parent, where Right opens the submenu (the Menu
 * component's own behaviour).
 *
 * OVERFLOW. The bar never lets itself be covered or clipped: when its host
 * gives it less room than its groups need, the trailing groups fold into a
 * "…" group whose menu lists each of them as a submenu (`menuBarOverflow.ts`).
 * The title bar's project chip used to sit on top of Help — and, with a long
 * project name, on View, Window and Plugins too — because nothing here could
 * get narrower. The folded group is an ordinary group to everything below:
 * roving focus, arrows and hover-switching all run over the folded list.
 *
 * In a right-to-left layout (`dir="rtl"` on the bar or an ancestor) the
 * groups run right-to-left too, so Left/Right are mirrored: "the next group"
 * is always the one the arrow points at.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Menu } from '@components/Menu';
import { useAppMenuGroups } from './useAppMenuGroups';
import { anchorMenuTo } from './menuAnchor';
import { MenuModelItems } from './MenuModelItems';
import { t } from '@core/i18n';
import { countFittingGroups, estimateGroupWidth, foldOverflowGroups, OVERFLOW_GROUP_ID } from './menuBarOverflow';
import styles from './AppMenuBar.module.css';

/** True when `el` renders right-to-left: an explicit `dir` wins, else the computed style. */
function isRtl(el: HTMLElement | null): boolean {
  if (!el) return false;
  const declared = el.closest('[dir]')?.getAttribute('dir');
  if (declared) return declared.toLowerCase() === 'rtl';
  return typeof getComputedStyle === 'function' && getComputedStyle(el).direction === 'rtl';
}

export function AppMenuBar(): JSX.Element {
  // Not the static APP_MENU: the Plugins group is assembled from what the user
  // installed and rebuilds as plugins start, stop and crash.
  const allGroups = useAppMenuGroups();
  // How many leading groups the bar has room for. Everything, until measured.
  const [fitCount, setFitCount] = useState<number>(Number.POSITIVE_INFINITY);
  // Rendered widths by label. A folded group is not in the DOM, so its width
  // is remembered from when it was — that is what lets the bar grow back.
  const widthCache = useRef<Map<string, number>>(new Map());
  const [naturalWidth, setNaturalWidth] = useState<number | null>(null);
  const overflowLabel = t('menu.overflow', 'More menus');
  const menuGroups = useMemo(
    () => foldOverflowGroups(allGroups, fitCount, overflowLabel),
    [allGroups, fitCount, overflowLabel],
  );
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  // Roving focus: the one group button that is tabbable.
  const [focusIdx, setFocusIdx] = useState(0);
  const barRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = (): void => {
      buttonRefs.current.forEach((btn, i) => {
        const g = menuGroups[i];
        if (btn && g && g.id !== OVERFLOW_GROUP_ID && btn.offsetWidth > 0) widthCache.current.set(g.label, btn.offsetWidth);
      });
      const widths = allGroups.map((g) => widthCache.current.get(g.label) ?? estimateGroupWidth(g.label));
      const gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
      const last = menuGroups.length - 1;
      const moreBtn = menuGroups[last]?.id === OVERFLOW_GROUP_ID ? buttonRefs.current[last] : null;
      const moreWidth = moreBtn && moreBtn.offsetWidth > 0 ? moreBtn.offsetWidth : 28;
      // The bar's flex-basis is its full, UNFOLDED width (the inline `width`
      // below), so its clientWidth reads "what the host can spare", not "what
      // is drawn right now" — without that a folded bar could never grow back.
      const natural = widths.reduce((a, w) => a + w, 0) + gap * Math.max(0, widths.length - 1);
      setNaturalWidth(widthCache.current.size > 0 ? Math.ceil(natural) : null);
      // 0 = not laid out (jsdom, a hidden pane): fold nothing rather than everything.
      const available = bar.clientWidth;
      setFitCount(available > 0 ? countFittingGroups(widths, gap, available, moreWidth) : Number.POSITIVE_INFINITY);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [allGroups, menuGroups]);

  // A group that folded away (or unfolded) under an open menu must not leave
  // that menu open, anchored to a button that is no longer on the bar.
  useEffect(() => {
    if (openGroup && !menuGroups.some((g) => g.id === openGroup)) setOpenGroup(null);
    if (focusIdx >= menuGroups.length) setFocusIdx(Math.max(0, menuGroups.length - 1));
  }, [menuGroups, openGroup, focusIdx]);

  const openAt = useCallback((groupId: string, btn: HTMLElement): void => {
    // Shared with AppMenuButton: left-aligned under the group, clamped to the
    // window — the rightmost groups (Window, Help) would otherwise open past
    // the right edge on a narrow window.
    setAnchor(anchorMenuTo(btn.getBoundingClientRect()));
    setOpenGroup(groupId);
  }, []);

  /** Move focus (and the open menu, if one is open) to group `idx`, wrapping. */
  const moveTo = useCallback((idx: number): void => {
    if (menuGroups.length === 0) return;
    const next = (idx + menuGroups.length) % menuGroups.length;
    setFocusIdx(next);
    const btn = buttonRefs.current[next];
    btn?.focus();
    const g = menuGroups[next];
    if (openGroup && g && btn) openAt(g.id, btn);
  }, [menuGroups, openGroup, openAt]);

  const close = useCallback((refocus: boolean): void => {
    setOpenGroup(null);
    if (refocus) buttonRefs.current[focusIdx]?.focus();
  }, [focusIdx]);

  /** +1 for the arrow that points along the reading direction, -1 against it. */
  const arrowStep = useCallback((key: 'ArrowLeft' | 'ArrowRight'): 1 | -1 => {
    const forward = key === 'ArrowRight';
    return (isRtl(barRef.current) ? !forward : forward) ? 1 : -1;
  }, []);

  useEffect(() => {
    if (!openGroup) return;
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (barRef.current?.contains(target)) return;
      if (document.getElementById('app-menu-dropdown')?.contains(target)) return;
      if ((target as Element).closest?.('[data-menu-portal]')) return;
      setOpenGroup(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const t = e.target as Element | null;
      // Only keys that landed in OUR dropdown; the bar's own buttons handle
      // theirs in `onBarKeyDown`.
      if (!t || !document.getElementById('app-menu-dropdown')?.contains(t)) return;
      // Inside a submenu, or on a parent that Right would open: the Menu
      // component owns those.
      if (t.closest('[data-menu-portal]')) return;
      if (t.getAttribute('aria-haspopup') === 'menu' && e.key === 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();
      const i = menuGroups.findIndex((g) => g.id === openGroup);
      moveTo(i + arrowStep(e.key));
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [openGroup, menuGroups, moveTo, close, arrowStep]);

  const onBarKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, idx: number): void => {
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); moveTo(idx + arrowStep('ArrowRight')); break;
      case 'ArrowLeft': e.preventDefault(); moveTo(idx + arrowStep('ArrowLeft')); break;
      case 'Home': e.preventDefault(); moveTo(0); break;
      case 'End': e.preventDefault(); moveTo(menuGroups.length - 1); break;
      case 'ArrowDown':
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const g = menuGroups[idx];
        const btn = buttonRefs.current[idx];
        if (g && btn) openAt(g.id, btn);
        break;
      }
      case 'Escape': e.preventDefault(); close(true); break;
      default: break;
    }
  };

  const group = menuGroups.find((g) => g.id === openGroup) ?? null;

  return (
    <div
      className={styles.bar}
      ref={barRef}
      role="menubar"
      aria-label="Application menu"
      style={naturalWidth !== null ? { width: naturalWidth } : undefined}
    >
      {menuGroups.map((g, i) => (
        <button
          key={g.id}
          ref={(el) => { buttonRefs.current[i] = el; }}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={openGroup === g.id}
          aria-label={g.id === OVERFLOW_GROUP_ID ? g.label : undefined}
          title={g.id === OVERFLOW_GROUP_ID ? g.label : undefined}
          tabIndex={i === focusIdx ? 0 : -1}
          className={openGroup === g.id ? styles.groupActive : styles.group}
          onClick={(e) => {
            setFocusIdx(i);
            if (openGroup === g.id) setOpenGroup(null);
            else openAt(g.id, e.currentTarget);
          }}
          onFocus={() => setFocusIdx(i)}
          onKeyDown={(e) => onBarKeyDown(e, i)}
          onPointerEnter={(e) => {
            if (openGroup && openGroup !== g.id) {
              setFocusIdx(i);
              openAt(g.id, e.currentTarget);
            }
          }}
        >
          {g.id === OVERFLOW_GROUP_ID ? '…' : g.label}
        </button>
      ))}

      {group && anchor
        ? createPortal(
            <div
              id="app-menu-dropdown"
              className={styles.dropdown}
              style={{ left: anchor.left, top: anchor.top }}
              aria-label={group.label}
            >
              <Menu noScroll onItemActivate={() => setOpenGroup(null)}>
                <MenuModelItems items={group.items} onActivate={() => setOpenGroup(null)} />
              </Menu>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
