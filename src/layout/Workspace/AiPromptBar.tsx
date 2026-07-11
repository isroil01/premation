/**
 * AiPromptBar — the assistant entry point, pinned to the bottom-center of the
 * viewport. A slim prompt that expands into a chat panel on focus. UI only —
 * no AI logic (that plugs in later behind onSubmit).
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import styles from './AiPromptBar.module.css';

export function AiPromptBar(): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState('');

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
            <p className={styles.empty}>
              Ask the assistant to animate, arrange, or generate. Your conversation appears here.
            </p>
          </div>
        </div>
      ) : null}

      <div className={styles.bar}>
        <span className={styles.spark} aria-hidden>✦</span>
        <input
          className={styles.input}
          placeholder="Ask anything…"
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          onFocus={() => setExpanded(true)}
        />
        <button type="button" className={styles.send} aria-label="Send" disabled={!value.trim()}>
          <Icon name="arrow-up" size={14} />
        </button>
      </div>
    </div>
  );
}
