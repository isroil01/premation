/**
 * ExpressionEditor — attach a formula that drives a property each frame
 * (spec §Expression Editor). VS-Code flavored: JetBrains Mono, quick-insert
 * autocomplete for the API, inline plain-language errors, a live value that
 * updates as you scrub, and AI-assist that turns intent into an editable
 * expression (never a locked result).
 */

import { useMemo, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { useActiveWorkspace } from '@stores/workspaceStore';
import { useSceneRevision } from '@stores/sceneStore';
import {
  defaultAnimation,
  sampleTrack,
  compileExpression,
  suggestExpression,
  tokenizeExpression,
  matchBracket,
  EXPRESSION_API,
  type TokenKind,
} from '@motion/animation';
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

  const enabled = defaultAnimation.hasExpression(nodeId, prop);

  // Live evaluation of the current draft at the playhead.
  const preview = useMemo(() => {
    const track = defaultAnimation.tracksFor(nodeId).find((t) => t.prop === prop);
    const base = track ? sampleTrack(track, time) ?? 0 : 0;
    return compileExpression(draft).run({ time, value: base });
  }, [draft, nodeId, prop, time]);

  const commit = (src: string): void => {
    setDraft(src);
    defaultAnimation.setExpression(nodeId, prop, src);
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
          <Icon name="track" size={12} className={styles.fx} /> Expression · {prop}
        </span>
        {enabled ? (
          <button
            type="button"
            className={styles.remove}
            title="Remove expression"
            onClick={() => { setDraft(''); defaultAnimation.removeExpression(nodeId, prop); }}
          >
            <Icon name="close" size={12} />
          </button>
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

      {/* Live value + inline error */}
      <div className={styles.status}>
        {preview.error ? (
          <span className={styles.error}><Icon name="warning" size={11} /> {preview.error}</span>
        ) : draft.trim() ? (
          <span className={styles.value}>= {preview.value?.toFixed(2) ?? '—'} <span className={styles.at}>@ {time.toFixed(2)}s</span></span>
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
        <Icon name="sparkles" size={13} className={styles.assistIcon} />
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
