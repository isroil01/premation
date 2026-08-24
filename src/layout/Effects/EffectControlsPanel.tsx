/**
 * Effect Controls — the left-sidebar editor for effects already on the
 * selected layer.
 *
 * The right inspector's Effects tab is the library you add FROM (effect types
 * and presets). This panel is only the applied stack: enable, reset, params.
 * Preset chips do not belong here — they are things you APPLY, and applying
 * is the right panel's job.
 *
 * Simulation modifiers (Cloner / Physics) and shape path ops also land here
 * once attached from the Effects browser — same "add there, edit here" split.
 */

import { EmptyState } from '@components/EmptyState';
import { Button } from '@components/Button';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useLayoutStore } from '@stores/layoutStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getNodeEffects } from '@core/effects/effects';
import { readPathOps } from '@core/scene/pathOps';
import { nodeHasCloner } from '@core/scene/clonerExpand';
import { nodeHasPhysics } from '@core/simulation/physicsBodies';
import { PathOpControls } from '@layout/Inspector/PathOpControls';
import { ClonerSection } from '@layout/Inspector/ClonerSection';
import { PhysicsSection } from '@layout/Inspector/PhysicsSection';
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
  const hasPathOps = readPathOps(node).length > 0;
  const hasCloner = nodeHasCloner(node);
  const hasPhysics = nodeHasPhysics(node);
  const hasAnything = count > 0 || hasPathOps || hasCloner || hasPhysics;

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
        {!hasAnything ? (
          <EmptyState
            compact
            icon="magic-wand"
            title="No effects"
            message="Add blurs, colour grades, Cloner or Physics from the Effects panel on the right."
            action={
              <Button size="sm" onClick={() => useLayoutStore.getState().openPanel('effects')}>
                Browse Effects
              </Button>
            }
          />
        ) : (
          <>
            {count > 0 && <EffectStack nodeId={primary} />}
            <PathOpControls nodeId={primary} />
            {hasCloner && <ClonerSection nodeId={primary} />}
            {hasPhysics && <PhysicsSection nodeId={primary} />}
          </>
        )}
      </div>
    </div>
  );
}

export default EffectControlsPanel;
