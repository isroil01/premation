/**
 * EffectControlsPanel — the dedicated AE-style "Effect Controls" panel: the
 * selected layer's applied effect stack with per-parameter keyframe stopwatches,
 * plus a compact "Add effect" menu. It reuses the shared {@link EffectStack} so
 * the stack has a single implementation (also shown in the Effects panel).
 * The searchable Effects & Presets browser is a separate panel.
 */

import { Icon } from '@components/Icon';
import { EmptyState } from '@components/EmptyState';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { EFFECT_DEFS, addEffect } from '@core/effects/effects';
import { EffectStack } from './EffectStack';
import styles from './EffectsPanel.module.css';

export function EffectControlsPanel(): JSX.Element {
  const primary = useSelectionStore((s) => s.primary);
  useSceneRevision((s) => s.rev);

  if (!primary || !defaultSceneGraph.getNode(primary)) {
    return <EmptyState icon="keyframe" message="Select a layer to view and animate its effects." />;
  }

  const addItems: DropdownItem[] = EFFECT_DEFS.map((d) => ({
    type: 'item',
    id: d.type,
    label: d.label,
    onSelect: () => addEffect(primary, d.type),
  }));

  return (
    <div className={styles.root}>
      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Effect Controls</span>
        <Dropdown
          placement="bottom-end"
          trigger={
            <button type="button" className={styles.blendTrigger}>
              <Icon name="plus" size={12} /> Add effect
            </button>
          }
          items={addItems}
        />
      </div>
      <EffectStack nodeId={primary} />
    </div>
  );
}

export default EffectControlsPanel;
