/**
 * AiPromptBar — the assistant entry point, pinned to the bottom-center of the
 * viewport. A slim prompt that expands into a chat panel on focus.
 *
 * Wired to the motion-back AI endpoint: it sends the live document + selection,
 * receives validated keyframe ops, and replays them through `applyAiOps` as one
 * reversible command. Works offline too — without a backend key the server
 * returns a deterministic preset, and without a session it still animates using
 * the local scene sent in the request body.
 */

import { useState, useCallback, type KeyboardEvent } from 'react';
import { Icon } from '@components/Icon';
import { api } from '@core/api/client';
import { captureDocument } from '@core/api/cloudDocument';
import { applyAiOps } from '@core/ai/applyOps';
import { useSelectionStore } from '@stores/selectionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import styles from './AiPromptBar.module.css';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export function AiPromptBar(): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const submit = useCallback(async () => {
    const prompt = value.trim();
    if (!prompt || busy) return;

    setBusy(true);
    setExpanded(true);
    setValue('');
    setMessages((m) => [...m, { role: 'user', text: prompt }]);

    try {
      const selection = useSelectionStore.getState().ids as string[];
      const ws = useWorkspaceStore.getState();
      const atTime = (ws.activeId ? ws.workspaces[ws.activeId]?.time : 0) ?? 0;
      const document = captureDocument();

      const result = await api.aiEdit({ prompt, document, selection, atTime });
      applyAiOps(result.label, result.ops);

      const suffix =
        result.ops.length === 0
          ? ''
          : ` (${result.ops.length} keyframe${result.ops.length === 1 ? '' : 's'})`;
      setMessages((m) => [...m, { role: 'assistant', text: result.message + suffix }]);
    } catch (err) {
      const message = (err as Error).message || 'The assistant could not complete that.';
      setMessages((m) => [...m, { role: 'assistant', text: `⚠ ${message}` }]);
    } finally {
      setBusy(false);
    }
  }, [value, busy]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  return (
    <div className={styles.wrap}>
      {expanded ? (
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <span className={styles.spark} aria-hidden>✦</span>
            <span className={styles.title}>Assistant</span>
            <button
              type="button"
              className={styles.collapse}
              aria-label="Collapse assistant"
              onClick={() => setExpanded(false)}
            >
              <Icon name="chevron-down" size={14} />
            </button>
          </div>
          <div className={styles.messages}>
            {messages.length === 0 ? (
              <p className={styles.empty}>
                Ask the assistant to animate, arrange, or generate. Your conversation appears here.
              </p>
            ) : (
              messages.map((m, i) => (
                <p
                  key={i}
                  className={styles.empty}
                  style={{
                    textAlign: m.role === 'user' ? 'right' : 'left',
                    opacity: m.role === 'user' ? 0.7 : 1,
                  }}
                >
                  {m.text}
                </p>
              ))
            )}
            {busy ? <p className={styles.empty}>Thinking…</p> : null}
          </div>
        </div>
      ) : null}

      <div className={styles.bar}>
        <span className={styles.spark} aria-hidden>✦</span>
        <input
          className={styles.input}
          placeholder="Ask anything…"
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.currentTarget.value)}
          onFocus={() => setExpanded(true)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className={styles.send}
          aria-label="Send"
          disabled={!value.trim() || busy}
          onClick={() => void submit()}
        >
          <Icon name="arrow-up" size={14} />
        </button>
      </div>
    </div>
  );
}
