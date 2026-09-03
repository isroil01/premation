/**
 * The completion list that hangs under the caret in the expression editor.
 *
 * Presentation only — no key handling lives here. The keys have to be caught on
 * the TEXTAREA, not on this list, because the list never has focus: taking
 * focus would move the caret out of the code the completion is about, and the
 * arrow keys would stop moving the caret when the popup is closed. So the
 * textarea owns `keydown` and this component is told which row is active.
 *
 * That also settles Escape. `ShortcutManager` listens on `window` in the
 * CAPTURE phase and would eat Escape as "Deselect" before any panel saw it —
 * except that it returns early for INPUT/TEXTAREA/SELECT targets (see
 * `isEditable`), so an Escape typed with the caret in the editor is ours by
 * default and needs no chord claim.
 *
 * Anchoring is an approximation on purpose: the caret's real pixel position
 * would need a mirror element measured every keystroke, and the editor is a
 * two-row box whose font is a known monospace token. `line`/`column` in `em`
 * and `ch` of that same token lands within a character of the caret and costs
 * no layout. Soft-wrapped long lines drift; the list stays readable and
 * attached to the box, which is what it is for.
 */

import { cn } from '@utils/cn';
import type { CompletionItem } from './expressionCompletion';
import styles from './ExpressionEditor.module.css';

/** Stable id for row `i` — the textarea points `aria-activedescendant` at it. */
export function completionOptionId(listId: string, i: number): string {
  return `${listId}-option-${i}`;
}

export interface ExpressionCompletionPopupProps {
  items: readonly CompletionItem[];
  /** Index into `items` of the highlighted row. */
  activeIndex: number;
  /** 0-based line the completed word starts on. */
  line: number;
  /** 0-based column the completed word starts at. */
  column: number;
  /** Id of the listbox; the textarea references it via `aria-controls`. */
  listId: string;
  onPick: (item: CompletionItem) => void;
  onHover: (index: number) => void;
}

export function ExpressionCompletionPopup({
  items,
  activeIndex,
  line,
  column,
  listId,
  onPick,
  onHover,
}: ExpressionCompletionPopupProps): JSX.Element | null {
  if (items.length === 0) return null;
  const active = items[activeIndex] ?? items[0];

  return (
    <div
      className={styles.complete}
      style={{
        top: `calc(var(--space-3) + ${line + 1} * var(--line-height-normal) * 1em)`,
        // Clamped: past ~32 columns the list would hang off the panel, and a
        // popup that has to be scrolled to is worse than one a few characters
        // left of the caret.
        left: `calc(var(--space-3) + ${Math.min(column, 32)}ch)`,
      }}
    >
      <ul className={styles.completeList} id={listId} role="listbox" aria-label="Expression completions">
        {items.map((item, i) => (
          <li
            key={item.label}
            id={completionOptionId(listId, i)}
            role="option"
            aria-selected={i === activeIndex}
            className={cn(styles.completeItem, i === activeIndex && styles.completeItemActive)}
            // mousedown, not click, and defaulted-prevented: a click would blur
            // the textarea first, and the caret the insertion needs is read
            // from it. Prevention keeps focus and the selection where they are.
            onMouseDown={(e) => { e.preventDefault(); onPick(item); }}
            onMouseEnter={() => onHover(i)}
          >
            <span className={styles.completeLabel}>{item.label}</span>
            <span className={styles.completeHint}>{item.hint}</span>
          </li>
        ))}
      </ul>
      {/* The example form of whatever is highlighted — what Enter would put in
          the document, visible before committing to it. */}
      <div className={styles.completeSignature}>{active?.signature}</div>
    </div>
  );
}

export default ExpressionCompletionPopup;
