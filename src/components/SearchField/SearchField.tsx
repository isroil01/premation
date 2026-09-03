/**
 * SearchField — the one "Search…" box.
 *
 * Every browser-ish panel in this app grew its own: the effects browser, the
 * motion presets browser, the plugin list, the font picker, the shortcut
 * editor, the timeline property filter, the transcript search. Each was a bare
 * `<Input placeholder="Search…" leftIcon="search" clearable>` with its own
 * `onClear`, its own (usually missing) `aria-label`, its own answer to what
 * Escape does, and — in three of them — no answer at all, so Escape fell
 * through to the global handler and closed the panel the user was typing in.
 *
 * That is not seven decisions; it is the absence of one. This component is the
 * decision:
 *
 *   • search icon on the left, clear button on the right once there is text
 *   • Escape CLEARS while there is text, and only blurs once already empty —
 *     so the first Escape never costs you the panel
 *   • an `aria-label` always, because "Search…" as placeholder-only leaves the
 *     field unnamed the moment the user types into it
 *   • an optional shortcut hint (⌘F and friends) shown while empty
 *   • an optional result count, announced politely for screen readers
 *   • optional debounce, for the panels that filter something expensive
 *
 * Controlled: `value` / `onChange`. With `debounceMs` the field still renders
 * every keystroke immediately (the draft is local); only the `onChange` call
 * is delayed. Clearing always flushes at once — a clear is never "pending".
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { cn } from '@utils/cn';
import { Icon } from '@components/Icon';
import styles from './SearchField.module.css';

export interface SearchFieldProps {
  /** Current query. Controlled. */
  value: string;
  /** Called with the new query — debounced when `debounceMs` is set. */
  onChange: (value: string) => void;
  placeholder?: string;
  /**
   * Accessible name. Defaults to the placeholder, falling back to "Search",
   * so a field is never left unnamed — but pass a real one when the panel has
   * more than one search box or the placeholder is decorative.
   */
  ariaLabel?: string;
  /** `sm` is the panel default; `md` for dialogs and full-width surfaces. */
  size?: 'sm' | 'md';
  /** Keyboard hint shown while the field is empty, e.g. "⌘F". */
  shortcut?: string;
  /** Optional "12 of 240" style slot, rendered inside the field, right-aligned. */
  resultCount?: ReactNode;
  /** Delay before `onChange` fires, in ms. 0 (default) = every keystroke. */
  debounceMs?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Stretch to the container width. Panels almost always want this. */
  fullWidth?: boolean;
  className?: string;
  id?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Runs before the built-in Escape handling; call `preventDefault()` to win. */
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

export function SearchField({
  value,
  onChange,
  placeholder = 'Search…',
  ariaLabel,
  size = 'sm',
  shortcut,
  resultCount,
  debounceMs = 0,
  disabled = false,
  autoFocus = false,
  fullWidth = true,
  className,
  id,
  inputRef,
  onKeyDown,
  onFocus,
  onBlur,
}: SearchFieldProps): JSX.Element {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const [draft, setDraft] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Last value we handed to `onChange` — anything else arriving in `value` is
   *  an external reset (a panel clearing its own filter) and must win. */
  const emittedRef = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const localRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (value === emittedRef.current) return;
    emittedRef.current = value;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setDraft(value);
  }, [value]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const emit = useCallback((next: string, immediate: boolean) => {
    setDraft(next);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (immediate || debounceMs <= 0) {
      emittedRef.current = next;
      onChangeRef.current(next);
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      emittedRef.current = next;
      onChangeRef.current(next);
    }, debounceMs);
  }, [debounceMs]);

  const clear = useCallback(() => {
    emit('', true);
    localRef.current?.focus();
  }, [emit]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || event.key !== 'Escape') return;
      // Escape on a field with text means "undo my typing", not "close this
      // panel" — swallow it. Only once the field is already empty does Escape
      // give the focus (and the key) back to whatever owns the panel.
      if (draft !== '') {
        event.preventDefault();
        event.stopPropagation();
        emit('', true);
        return;
      }
      localRef.current?.blur();
    },
    [draft, emit, onKeyDown],
  );

  const hasText = draft !== '';
  const label = ariaLabel ?? (placeholder.replace(/…|\.\.\./g, '').trim() || 'Search');

  return (
    <div
      className={cn(
        styles.root,
        styles[size],
        fullWidth && styles.fullWidth,
        disabled && styles.disabled,
        className,
      )}
      data-size={size}
    >
      <Icon name="search" size="sm" className={styles.icon} />
      <input
        ref={(node) => {
          localRef.current = node;
          if (typeof inputRef === 'function') inputRef(node);
          else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = node;
        }}
        id={fieldId}
        type="text"
        role="searchbox"
        className={styles.input}
        value={draft}
        placeholder={placeholder}
        aria-label={label}
        disabled={disabled}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => emit(event.currentTarget.value, false)}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
      />
      {resultCount !== undefined && resultCount !== null && resultCount !== false ? (
        <span className={styles.count} aria-live="polite">
          {resultCount}
        </span>
      ) : null}
      {hasText ? (
        <button
          type="button"
          className={styles.clear}
          // Fixed wording rather than "Clear <this field's name>": the label
          // can be a whole sentence ("Search by command name, action, or
          // shortcut key…"), and a clear button called that is worse than one
          // called nothing.
          aria-label="Clear search"
          title="Clear"
          tabIndex={-1}
          onClick={clear}
        >
          <Icon name="close" size="sm" />
        </button>
      ) : shortcut ? (
        <kbd className={styles.shortcut} aria-hidden>
          {shortcut}
        </kbd>
      ) : null}
    </div>
  );
}
