/**
 * AiSparkleButton — the single, quiet home for AI suggestions in the toolbar.
 *
 * Spec: "Passive suggestions collect behind a single small purple sparkle
 * button in the toolbar, which badges quietly when suggestions exist." Clicking
 * it opens the suggestions for the current selection and the global mode
 * control (Normal / Minimal / Off). Purple is used exclusively for AI.
 */

import { Icon } from '@components/Icon';
import { Popover } from '@components/Popover';
import { cn } from '@utils/cn';
import { useUIStore } from '@stores/uiStore';
import { useActiveWorkspace } from '@stores/workspaceStore';
import { useAiSuggestionStore, type SuggestionMode } from '@stores/aiSuggestionStore';
import { useContextualSuggestions } from '@layout/ai/useSuggestions';
import { applySuggestion } from '@core/ai/suggestions';
import styles from './AiSparkleButton.module.css';

const MODES: { value: SuggestionMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'off', label: 'Off' },
];

export function AiSparkleButton(): JSX.Element {
  const mode = useAiSuggestionStore((s) => s.mode);
  const setMode = useAiSuggestionStore((s) => s.setMode);
  const notify = useUIStore((s) => s.notify);
  const time = useActiveWorkspace()?.time ?? 0;
  const { nodeId, name, suggestions } = useContextualSuggestions();

  const badgeCount = mode === 'off' ? 0 : suggestions.length;

  const trigger = (
    <button type="button" className={styles.trigger} aria-label="AI suggestions" title="AI suggestions">
      <Icon name="sparkles" size={16} />
      {badgeCount > 0 ? <span className={styles.badge}>{badgeCount}</span> : null}
    </button>
  );

  return (
    <Popover trigger={trigger} placement="bottom-end">
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <Icon name="sparkles" size={13} className={styles.headerIcon} />
          <span className={styles.headerTitle}>AI Suggestions</span>
        </div>

        <div className={styles.modeRow} role="radiogroup" aria-label="Suggestion mode">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              className={cn(styles.modeChip, mode === m.value && styles.modeChipOn)}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>

        {mode === 'off' ? (
          <p className={styles.empty}>Suggestions are off.</p>
        ) : !nodeId ? (
          <p className={styles.empty}>Select a layer to see suggestions.</p>
        ) : suggestions.length === 0 ? (
          <p className={styles.empty}>No suggestions for {name}.</p>
        ) : (
          <div className={styles.list}>
            {suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                className={styles.item}
                title={s.description}
                onClick={() => {
                  applySuggestion(s, nodeId, time);
                  notify({ level: 'info', message: `Applied “${s.label}” — fully editable in the timeline`, durationMs: 2600 });
                }}
              >
                <Icon name={s.icon} size={13} className={styles.itemIcon} />
                <span className={styles.itemLabel}>{s.label}</span>
                <span className={styles.itemDesc}>{s.description}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Popover>
  );
}

export default AiSparkleButton;
