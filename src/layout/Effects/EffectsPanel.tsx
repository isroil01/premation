/**
 * EffectsPanel — per-layer visual effects (blur, glow, color grades). Add from
 * the palette of effect types; each applied effect gets a scrubbable amount and
 * a remove control. Effects render live on the canvas and are captured by
 * History / autosave / export.
 */

import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { EmptyState } from '@components/EmptyState';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import {
  EFFECT_DEFS,
  getNodeEffects,
  addEffect,
  updateEffect,
  removeEffect,
} from '@core/effects/effects';
import styles from './EffectsPanel.module.css';

export function EffectsPanel(): JSX.Element {
  const primary = useSelectionStore((s) => s.primary);
  useSceneRevision((s) => s.rev);

  if (!primary || !defaultSceneGraph.getNode(primary)) {
    return <EmptyState icon="settings" message="Select a layer to add visual effects." />;
  }

  const effects = getNodeEffects(primary);
  const defByType = new Map(EFFECT_DEFS.map((d) => [d.type, d]));

  return (
    <div className={styles.root}>
      <div className={styles.addRow}>
        {EFFECT_DEFS.map((d) => (
          <button key={d.type} type="button" className={styles.addChip} onClick={() => addEffect(primary, d.type)}>
            <Icon name="plus" size={11} /> {d.label}
          </button>
        ))}
      </div>

      {effects.length === 0 ? (
        <EmptyState icon="sparkles" message="No effects — add one above to grade or blur this layer." />
      ) : (
        <div className={styles.list}>
          {effects.map((e) => {
            const def = defByType.get(e.type);
            if (!def) return null;
            return (
              <div key={e.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <span className={styles.itemLabel}>{def.label}</span>
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={`Remove ${def.label}`}
                    onClick={() => removeEffect(primary, e.id)}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
                <ValueField
                  value={e.amount}
                  min={def.min}
                  max={def.max}
                  unit={def.unit}
                  precision={0}
                  onChange={(v) => updateEffect(primary, e.id, v)}
                  aria-label={`${def.label} amount`}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default EffectsPanel;
