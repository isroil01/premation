/**
 * AiSuggestionCard — the contextual, near-the-object suggestion card.
 *
 * Anti-Clippy behavior (spec):
 *   - Only in Normal mode; Minimal/Off never auto-show it.
 *   - Anchored to the workspace top-left — never over the canvas center or the
 *     active controls (zoom bar / AI prompt bar sit elsewhere).
 *   - Never steals focus (plain div, no autofocus).
 *   - Fades in at motion-base (160ms) then SITS STILL — no attention-grabbing
 *     looping motion.
 *   - Per-suggestion dismissal is remembered per asset; the card itself can be
 *     closed for a node without losing the suggestions (still under the sparkle).
 *   - Purple is used exclusively for AI.
 */

import { Icon } from '@components/Icon';
import { useUIStore } from '@stores/uiStore';
import { useActiveWorkspace } from '@stores/workspaceStore';
import { useAiSuggestionStore } from '@stores/aiSuggestionStore';
import { useContextualSuggestions } from '@layout/ai/useSuggestions';
import styles from './AiSuggestionCard.module.css';

export function AiSuggestionCard(): JSX.Element | null {
  const mode = useAiSuggestionStore((s) => s.mode);
  const dismiss = useAiSuggestionStore((s) => s.dismiss);
  const closeCard = useAiSuggestionStore((s) => s.closeCard);
  const isCardClosed = useAiSuggestionStore((s) => s.closedCards);
  const notify = useUIStore((s) => s.notify);
  const time = useActiveWorkspace()?.time ?? 0;

  const { nodeId, name, suggestions } = useContextualSuggestions();

  // Only the Normal mode shows the auto card.
  if (mode !== 'normal') return null;
  if (!nodeId || suggestions.length === 0) return null;
  if (isCardClosed[nodeId]) return null;

  return (
    <div className={styles.card} role="complementary" aria-label="AI suggestions">
      <div className={styles.header}>
        <span className={styles.title}>
          <Icon name="sparkles" size={13} className={styles.sparkle} />
          Suggestions for {name}
        </span>
        <button
          type="button"
          className={styles.close}
          aria-label="Dismiss suggestions"
          title="Dismiss"
          onClick={() => closeCard(nodeId)}
        >
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className={styles.chips}>
        {suggestions.map((s) => (
          <div key={s.id} className={styles.chip}>
            <button
              type="button"
              className={styles.chipApply}
              title={s.description}
              onClick={() => {
                s.apply(nodeId, time);
                notify({ level: 'info', message: `Applied “${s.label}” — fully editable in the timeline`, durationMs: 2600 });
              }}
            >
              <Icon name={s.icon} size={13} className={styles.chipIcon} />
              {s.label}
            </button>
            <button
              type="button"
              className={styles.chipDismiss}
              aria-label={`Dismiss ${s.label}`}
              title="Don't suggest this again"
              onClick={() => dismiss(nodeId, s.id)}
            >
              <Icon name="close" size={10} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default AiSuggestionCard;
