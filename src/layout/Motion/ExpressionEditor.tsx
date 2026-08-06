/**
 * ExpressionEditor — attach a formula that drives a property each frame
 *. VS-Code flavored: JetBrains Mono, quick-insert
 * autocomplete for the API, inline plain-language errors, a live value that
 * updates as you scrub, and AI-assist that turns intent into an editable
 * expression (never a locked result).
 */

import { useMemo, useRef, useState } from 'react';
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
import styles from './ExpressionEditor.module.css';

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
          onChange={(e) => { commit(e.currentTarget.value); syncCaret(e.currentTarget); }}
          onKeyUp={(e) => syncCaret(e.currentTarget)}
          onClick={(e) => syncCaret(e.currentTarget)}
          onSelect={(e) => syncCaret(e.currentTarget)}
          onScroll={(e) => {
            if (preRef.current) {
              preRef.current.scrollTop = e.currentTarget.scrollTop;
              preRef.current.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
        />
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

      {/* Quick-insert autocomplete */}
      <div className={styles.api}>
        {EXPRESSION_API.map((a) => (
          <button key={a.label} type="button" className={styles.apiChip} title={a.hint} onClick={() => insert(a.insert)}>
            {a.label}
          </button>
        ))}
      </div>

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
