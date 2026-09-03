/**
 * ExpressionEditor — attach a formula that drives a property each frame.
 *
 * VS-Code flavoured: JetBrains Mono, quick-insert autocomplete for the API,
 * inline plain-language errors, a live value that updates as you scrub, and
 * AI-assist that turns intent into an editable expression (never a locked
 * result).
 *
 * ── The pick-whip ──────────────────────────────────────────────────────
 * Everything above is nicer than After Effects' expression field, and none of
 * it replaces the one gesture people actually use to write an expression:
 * dragging a whip onto another property. Typing `layer('Hero', 'y')` requires
 * knowing the function, the layer's exact name and the property's internal key;
 * dragging requires knowing which layer you meant.
 *
 * Dropping on a PROPERTY row references that property. Dropping on a LAYER
 * references the same property this expression is on — "follow that layer's Y",
 * which is what the gesture means when you drag from Y, and what AE produces.
 */

import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { useActiveWorkspace } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import {
  defaultAnimation,
  suggestExpression,
  tokenizeExpression,
  matchBracket,
  EXPRESSION_API,
  type TokenKind,
} from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { PickWhip } from '@components/PickWhip';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { insertAtCaret, whipExpression } from '@core/whip/whipTarget';
import { applyCompletion, completionsAt, wordAtCaret, type CompletionItem } from './expressionCompletion';
import { ExpressionCompletionPopup, completionOptionId } from './ExpressionCompletionPopup';
import styles from './ExpressionEditor.module.css';

/** Chars that, once typed, mean the caret is inside a name worth completing. */
const OPENS_COMPLETION = /[A-Za-z0-9_$.]/;
const COMPLETION_LIST_ID = 'expression-completions';

const TOKEN_CLASS: Record<TokenKind, string | undefined> = {
  num: styles.tNum,
  str: styles.tStr,
  api: styles.tApi,
  ident: styles.tIdent,
  op: styles.tOp,
  paren: styles.tParen,
  ws: '',
};

export function ExpressionEditor({ nodeId, prop }: { nodeId: string; prop: string }): JSX.Element {
  useSceneRevision((s) => s.rev);
  // Expressions live in the AnimationEngine, not a store. Every state this
  // panel showed until now happened to change local `draft` too, so a scene
  // bump was enough by accident; the enable/disable toggle changes ONLY engine
  // state, and without this the switch stays visually on after turning it off.
  useAnimationRevision();
  const time = useActiveWorkspace()?.time ?? 0;

  const stored = defaultAnimation.getExpressionSrc(nodeId, prop) ?? '';
  const [draft, setDraft] = useState(stored);
  // Re-seed when switching property/layer.
  const key = `${nodeId}:${prop}`;
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    setDraft(stored);
  }

  const [intent, setIntent] = useState('');
  const [caret, setCaret] = useState(0);
  const [completionOpen, setCompletionOpen] = useState(false);
  const [activeCompletion, setActiveCompletion] = useState(0);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  // Syntax tokens + matching-bracket pair for the highlight overlay.
  const tokens = useMemo(() => tokenizeExpression(draft), [draft]);
  const matched = useMemo(() => matchBracket(draft, caret), [draft, caret]);
  const syncCaret = (el: HTMLTextAreaElement): void => setCaret(el.selectionStart ?? 0);

  // TWO questions, not one. `attached` decides whether the header's controls
  // exist at all; `enabled` decides whether the formula is driving the property
  // right now. This variable used to be called `enabled` and held
  // `hasExpression` — the exact conflation the model change exists to end.
  const attached = defaultAnimation.hasExpression(nodeId, prop);
  const enabled = defaultAnimation.isExpressionEnabled(nodeId, prop);

  // Live evaluation of the current draft at the playhead — through the engine
  // so valueAtTime / layer / loopOut preview exactly as playback resolves.
  const preview = useMemo(
    () => defaultAnimation.previewExpression(nodeId, prop, draft, time),
    [draft, nodeId, prop, time],
  );

  const commit = (src: string): void => {
    setDraft(src);
    runAnimEdit('Set Expression', () => {
      defaultAnimation.setExpression(nodeId, prop, src);
    });
  };

  const insert = (token: string): void => {
    const el = taRef.current;
    const next = el && el.selectionStart != null
      ? draft.slice(0, el.selectionStart) + token + draft.slice(el.selectionEnd)
      : (draft ? `${draft} ${token}` : token);
    commit(next);
  };

  // ── Autocomplete ────────────────────────────────────────────────────────
  // The list is derived, never stored: `completionOpen` is the only state, so
  // the rows can never be stale with respect to the text they complete.
  const { word, items } = useMemo(
    () => (completionOpen ? completionsAt(draft, caret) : { word: null, items: [] }),
    [completionOpen, draft, caret],
  );
  const showCompletions = completionOpen && items.length > 0 && word != null;
  // Anchor: which line the half-typed word starts on, and how far into it.
  // Approximate by construction — see the note in the popup.
  const before = word ? draft.slice(0, word.start) : '';
  const line = before.split('\n').length - 1;
  const column = word ? word.start - (before.lastIndexOf('\n') + 1) : 0;
  const activeIndex = items.length === 0 ? 0 : Math.min(activeCompletion, items.length - 1);

  const closeCompletions = (): void => setCompletionOpen(false);

  const openCompletions = (): void => {
    setActiveCompletion(0);
    setCompletionOpen(true);
  };

  /**
   * Accept a row.
   *
   * The caret is read from the ELEMENT rather than from `caret` state for the
   * same reason the pick-whip does: a mouse pick never touched the textarea, so
   * the state value can lag by one interaction and the insertion would land at
   * the previous caret.
   */
  const acceptCompletion = (item: CompletionItem): void => {
    const el = taRef.current;
    const at = el?.selectionStart ?? caret;
    const next = applyCompletion(draft, at, item);
    commit(next.text);
    setCaret(next.caret);
    closeCompletions();
    // After the controlled value has re-rendered — setting the selection before
    // that puts it at the end of the old text.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };

  /**
   * Keys the popup claims, handled on the textarea.
   *
   * Nothing global competes here: `ShortcutManager`'s window-capture listener
   * returns immediately when the event target is a TEXTAREA, so Escape reaches
   * this handler instead of running "Deselect". `stopPropagation` is still
   * called on the keys we consume, to keep them off any ancestor handler.
   */
  const onEditorKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.ctrlKey && (e.key === ' ' || e.code === 'Space')) {
      e.preventDefault();
      openCompletions();
      return;
    }
    if (!showCompletions) return;
    const step = (d: number): void => {
      e.preventDefault();
      e.stopPropagation();
      setActiveCompletion((i) => (Math.min(i, items.length - 1) + d + items.length) % items.length);
    };
    if (e.key === 'ArrowDown') { step(1); return; }
    if (e.key === 'ArrowUp') { step(-1); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const item = items[activeIndex];
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      acceptCompletion(item);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeCompletions();
    }
  };

  /**
   * Insert a reference to whatever the whip landed on.
   *
   * The caret is read from the textarea rather than from `caret` state: the
   * pointer-down that started the drag did not touch the textarea, so the state
   * value is whatever it was before — and a whip dropped after clicking away
   * would otherwise insert at a stale position.
   */
  const insertWhipReference = (target: { nodeId: string; prop?: string }): void => {
    const name = defaultSceneGraph.getNode(target.nodeId)?.name;
    if (!name) return;
    const el = taRef.current;
    const at = el?.selectionStart ?? draft.length;
    const next = insertAtCaret(draft, at, whipExpression(name, target.prop ?? prop));
    commit(next.text);
    setCaret(next.caret);
    // Focus and caret restored on the next tick, after the controlled value
    // has been re-rendered — setting selection before that puts it at the end.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };

  const generate = (): void => {
    if (!intent.trim()) return;
    commit(suggestExpression(intent));
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>
          <Icon name="track" size="sm" className={styles.fx} /> Expression · {prop}
        </span>
        <span className={styles.headerActions}>
          <PickWhip
            label="Expression pick-whip — drag onto a layer or property"
            // Itself excluded: an expression that reads its own property is a
            // cycle, and the evaluator would refuse it after the fact.
            accept={(target) => !(target.nodeId === nodeId && (target.prop ?? prop) === prop)}
            onPick={insertWhipReference}
          />
        </span>
        {attached ? (
          <span className={styles.headerActions}>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Expression enabled"
              className={cn(styles.toggle, !enabled && styles.toggleOff)}
              title={enabled ? 'Disable expression (keeps the formula)' : 'Enable expression'}
              onClick={() => {
                runAnimEdit(enabled ? 'Disable Expression' : 'Enable Expression', () => {
                  defaultAnimation.setExpressionEnabled(nodeId, prop, !enabled);
                });
              }}
            >
              <Icon name={enabled ? 'eye' : 'eye-off'} size="sm" />
            </button>
            <button
              type="button"
              className={styles.remove}
              title="Remove expression"
              aria-label="Remove expression"
              onClick={() => {
                setDraft('');
                runAnimEdit('Remove Expression', () => {
                  defaultAnimation.removeExpression(nodeId, prop);
                });
              }}
            >
              <Icon name="close" size="sm" />
            </button>
          </span>
        ) : null}
      </div>

      <div className={styles.codeWrap}>
        {/* Highlighted mirror behind the transparent-text textarea. */}
        <pre className={styles.highlight} aria-hidden ref={preRef}>
          {tokens.map((t, i) => {
            const isMatch =
              t.kind === 'paren' && matched != null && (t.start === matched[0] || t.start === matched[1]);
            return (
              <span key={i} className={cn(TOKEN_CLASS[t.kind], isMatch && styles.tMatch)}>
                {t.text}
              </span>
            );
          })}
          {'\n'}
        </pre>
        <textarea
          ref={taRef}
          className={styles.editor}
          value={draft}
          spellCheck={false}
          placeholder="e.g. wiggle(2, 30)  ·  time * 90  ·  value + Math.sin(time*3)*40"
          rows={2}
          // Combobox rather than plain textbox while the list can appear, so a
          // screen reader announces the highlighted row as it changes. The list
          // itself never takes focus — see the popup's header comment.
          role="combobox"
          aria-label={`Expression for ${prop}`}
          aria-autocomplete="list"
          aria-expanded={showCompletions}
          aria-controls={COMPLETION_LIST_ID}
          {...(showCompletions ? { 'aria-activedescendant': completionOptionId(COMPLETION_LIST_ID, activeIndex) } : {})}
          onChange={(e) => {
            const el = e.currentTarget;
            const next = el.value;
            const at = el.selectionStart ?? next.length;
            commit(next);
            setCaret(at);
            // Open on any keystroke that leaves the caret inside a name. The
            // ≥1-char rule is what keeps a bare `(` or a space from popping the
            // whole API — the old chip strip's failure mode, on every keypress.
            const typed = next.slice(at - 1, at);
            const w = wordAtCaret(next, at);
            if (OPENS_COMPLETION.test(typed) && (w.member.length >= 1 || w.object.length >= 1)) {
              openCompletions();
            } else {
              closeCompletions();
            }
          }}
          onKeyDown={onEditorKeyDown}
          onKeyUp={(e) => syncCaret(e.currentTarget)}
          onClick={(e) => { syncCaret(e.currentTarget); closeCompletions(); }}
          onSelect={(e) => syncCaret(e.currentTarget)}
          onBlur={closeCompletions}
          onScroll={(e) => {
            if (preRef.current) {
              preRef.current.scrollTop = e.currentTarget.scrollTop;
              preRef.current.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
        />
        {showCompletions ? (
          <ExpressionCompletionPopup
            items={items}
            activeIndex={activeIndex}
            line={line}
            column={column}
            listId={COMPLETION_LIST_ID}
            onPick={acceptCompletion}
            onHover={setActiveCompletion}
          />
        ) : null}
      </div>

      {/* Live value + inline error.
          The disabled notice comes FIRST and replaces the live value: showing
          "= 42.00" beside a formula that is not driving anything is the whole
          bug this feature is meant to prevent, in the one panel that should
          know better. `preview` still evaluates the draft — that is what makes
          the toggle safe to use, since you can see what re-enabling would do —
          but it is not presented as the property's value. */}
      <div className={styles.status}>
        {attached && !enabled ? (
          <span className={styles.muted}>
            Disabled — the property uses its keyframes. Would be{' '}
            {preview.error
              ? '—'
              : preview.value === null
                ? '—'
                : Array.isArray(preview.value)
                  ? `[${preview.value.map((v) => v.toFixed(2)).join(', ')}]`
                  : preview.value.toFixed(2)}{' '}
            <span className={styles.at}>@ {time.toFixed(2)}s</span>
          </span>
        ) : preview.error ? (
          <span className={styles.error}><Icon name="warning" size="sm" /> {preview.error}</span>
        ) : draft.trim() ? (
          <span className={styles.value}>= {preview.value === null ? '—' : Array.isArray(preview.value) ? `[${preview.value.map((v) => v.toFixed(2)).join(', ')}]` : preview.value.toFixed(2)} <span className={styles.at}>@ {time.toFixed(2)}s</span></span>
        ) : (
          <span className={styles.muted}>No expression — the property uses its keyframes.</span>
        )}
      </div>

      {/* The full reference, folded away.
          These chips WERE the autocomplete: fifty buttons, always open, in the
          order the language grew. As a completion they were beaten by typing;
          as a reference they are still the only place the whole API is visible
          at once, which is worth keeping — closed by default, because the panel
          should be the code and its value, not a wall of names. */}
      <details className={styles.reference}>
        <summary className={styles.referenceSummary}>
          Reference · {EXPRESSION_API.length} names
          <span className={styles.referenceHint}>type to complete · Ctrl+Space</span>
        </summary>
        <div className={styles.api}>
          {EXPRESSION_API.map((a) => (
            <button key={a.label} type="button" className={styles.apiChip} title={a.hint} onClick={() => insert(a.insert)}>
              {a.label}
            </button>
          ))}
        </div>
      </details>

      {/* AI-assist */}
      <div className={styles.assist}>
        <Icon name="sparkles" size="sm" className={styles.assistIcon} />
        <input
          className={styles.assistInput}
          value={intent}
          placeholder="Describe motion → expression"
          onChange={(e) => setIntent(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') generate(); }}
        />
        <button type="button" className={cn(styles.assistBtn, !intent.trim() && styles.assistBtnOff)} onClick={generate}>
          Generate
        </button>
      </div>
    </div>
  );
}

export default ExpressionEditor;
