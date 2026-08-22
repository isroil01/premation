/**
 * BrowserTree — the After Effects "Effects & Presets" browser, as chrome.
 *
 * Two panels browse a keyword-searched, folder-grouped library: the Effects tab
 * (~90 effect types in eight AE folders) and the Presets tab. They had drifted
 * into two different-looking lists — one a column of bordered cards with icon
 * tiles and hover lift, the other a grid of preview cards — sharing only an
 * `Accordion`. This is the one browser both now render, so a folder opens the
 * same way, a row highlights the same way, and the search reads the same way in
 * either tab.
 *
 * Presentational by construction: it knows nothing about effects, presets, the
 * scene graph or drag payloads. Each panel keeps its own wiring and passes rows
 * in, exactly as `PropertyRow` is shared between the timeline and the inspector.
 *
 * ── `forceOpen`, and the bug it fixes ───────────────────────────────────────
 * `Accordion` seeds its open set from `defaultOpen` in a `useState` INITIALISER,
 * so the flag is read once, at mount, and never again. Both panels passed a
 * search-derived value there — `defaultOpen: !!search.trim()` — believing that
 * typing would open the folders holding the matches. It could not: the state was
 * already seeded. Searching filtered the tree down to two folders and left both
 * shut, which reads as "no results". `forceOpen` is a RENDER-TIME override, not
 * a seed, so it tracks the search on every keystroke.
 */

import { useId, useState, type ReactNode } from 'react';
import { cn } from '@utils/cn';
import { Icon, type IconName } from '@components/Icon';
import styles from './BrowserTree.module.css';

export function BrowserTree({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn(styles.tree, className)} role="tree">
      {children}
    </div>
  );
}

export interface BrowserFolderProps {
  label: string;
  /** The folder's subject, one glyph. See EFFECT_CATEGORY_ICON. */
  icon?: IconName;
  /** Shown right-aligned, revealed on hover or while open. */
  count?: number;
  /** Initial open state. Read once, at mount — see `forceOpen`. */
  defaultOpen?: boolean;
  /**
   * Render open regardless of the user's own toggling, re-evaluated every
   * render. This is what a live search needs; `defaultOpen` cannot do it.
   */
  forceOpen?: boolean;
  children: ReactNode;
}

export function BrowserFolder({
  label,
  icon,
  count,
  defaultOpen = false,
  forceOpen = false,
  children,
}: BrowserFolderProps): JSX.Element {
  const baseId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = forceOpen || open;

  return (
    <div className={styles.folder}>
      <button
        type="button"
        className={styles.folderHead}
        aria-expanded={isOpen}
        aria-controls={baseId}
        // While a search is forcing folders open, clicking the header would
        // flip invisible state and appear to do nothing. Collapsing is simply
        // not offered until the search is cleared.
        onClick={() => { if (!forceOpen) setOpen((v) => !v); }}
      >
        <span className={styles.twisty} aria-hidden>
          <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size="sm" />
        </span>
        {icon ? <Icon name={icon} size="md" className={styles.folderIcon} /> : null}
        <span className={styles.folderName}>{label}</span>
        {count !== undefined && <span className={styles.count}>{count}</span>}
      </button>
      {isOpen && (
        <div className={styles.folderBody} id={baseId} role="group">
          {children}
        </div>
      )}
    </div>
  );
}

export interface BrowserRowProps {
  label: string;
  /** AE's `fx` mark. Effects show it; presets and folders-of-things do not. */
  fx?: boolean;
  /** An icon instead of the `fx` mark. */
  icon?: IconName;
  /** Leading custom content — a preview thumbnail, say. Wins over `fx`/`icon`. */
  leading?: ReactNode;
  /** Trailing slot: a tag, a delete button. */
  right?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onDoubleClick?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  /** For a consumer that needs a taller row — e.g. one carrying a preview. */
  className?: string;
}

export function BrowserRow({
  label,
  fx = false,
  icon,
  leading,
  right,
  selected = false,
  disabled = false,
  title,
  onClick,
  onDoubleClick,
  draggable,
  onDragStart,
  className,
}: BrowserRowProps): JSX.Element {
  return (
    <button
      type="button"
      className={cn(styles.row, className)}
      data-selected={selected || undefined}
      disabled={disabled}
      title={title}
      role="treeitem"
      aria-selected={selected}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      draggable={draggable}
      onDragStart={onDragStart}
    >
      {leading ?? (fx ? <span className={styles.fx} aria-hidden>fx</span> : null)}
      {!leading && !fx && icon ? <Icon name={icon} size="sm" className={styles.rowIcon} /> : null}
      <span className={styles.rowLabel}>{label}</span>
      {right ? <span className={styles.rowRight}>{right}</span> : null}
    </button>
  );
}

/** A quiet uppercase marker for the row's trailing slot ("GPU"). */
export function BrowserTag({ children }: { children: ReactNode }): JSX.Element {
  return <span className={styles.tag}>{children}</span>;
}

export function BrowserEmpty({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.empty}>{children}</div>;
}

export default BrowserTree;
