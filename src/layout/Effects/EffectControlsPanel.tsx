/**
 * Effect Controls — the left-sidebar editor for effects already on the
 * selected layer.
 *
 * The right inspector's Effects tab is the library you add FROM (effect types
 * and presets). This panel is only the applied stack: enable, reset, params.
 * Preset chips do not belong here — they are things you APPLY, and applying
 * is the right panel's job.
 */

import { EmptyState } from '@components/EmptyState';
import { Button } from '@components/Button';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useLayoutStore } from '@stores/layoutStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getNodeEffects } from '@core/effects/effects';
import { PathOpControls } from '@layout/Inspector/PathOpControls';
import { EffectStack } from './EffectStack';
import styles from './EffectsPanel.module.css';

export function EffectControlsPanel(): JSX.Element {
  const primary = useSelectionStore((s) => s.primary);
  useSceneRevision((s) => s.rev);

  const node = primary ? defaultSceneGraph.getNode(primary) : undefined;
  if (!primary || !node) {
    return (
      <EmptyState
        icon="stopwatch"
        title="Effect Controls"
        message="Select a layer to edit the effects applied to it. Add effects from the Effects panel on the right."
      />
    );
  }

  const count = getNodeEffects(primary).length;
  const layerName = node.name?.trim() || primary;

  return (
    <div className={styles.controlsRoot}>
      <div className={styles.layerHead}>
        <span className={styles.fxMark} aria-hidden>fx</span>
        <span className={styles.layerName} title={layerName}>{layerName}</span>
        {count > 0 && (
          <span className={styles.layerCount}>
            {count} {count === 1 ? 'effect' : 'effects'}
          </span>
        )}
      </div>

      <div className={styles.controlsBody}>
        {count === 0 ? (
          <EmptyState
            compact
            icon="magic-wand"
            title="No effects"
            message="Add blurs, colour grades and stylize effects from the Effects panel on the right."
            action={
              <Button size="sm" onClick={() => useLayoutStore.getState().openPanel('effects')}>
                Browse Effects
              </Button>
            }
          />
        ) : (
          <EffectStack nodeId={primary} />
        )}
        <PathOpControls nodeId={primary} />
      </div>
    </div>
  );
}

export default EffectControlsPanel;
