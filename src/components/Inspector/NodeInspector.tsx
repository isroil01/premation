import { InspectorRow } from './Inspector';
import { propertyRegistry } from '@core/inspector/PropertyRegistry';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { useActiveWorkspace } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import styles from './NodeInspector.module.css';

/**
 * A single editable property row with keyframe authoring.
 *
 * For numeric props a stopwatch toggles animation on/off. While animated, the
 * field shows the sampled value at the playhead and edits write a keyframe at
 * the current time (AE‑style) — routed to the Animation Engine, not the base
 * scene value. Non‑animated edits go to the base value as before.
 *
 * Isolated into its own component so hooks stay stable as the selection changes.
 */
function PropertyRow({
  nodeId,
  componentId,
  componentType,
  propName,
}: {
  nodeId: string;
  componentId: string;
  componentType: string;
  propName: string;
}): JSX.Element {
  const [baseVal, setBaseVal] = useNodeComponentProp(defaultSceneGraph, nodeId, componentId, propName);
  const time = useActiveWorkspace()?.time ?? 0;
  // Subscribe to the revision so the row re-renders on keyframe/scene changes.
  useSceneRevision((s) => s.rev);

  const Editor = propertyRegistry.get(componentType, propName);
  const numeric = typeof baseVal === 'number';
  const animated = numeric && defaultAnimation.isAnimated(nodeId, propName);
  const displayVal = animated ? defaultAnimation.sample(nodeId, propName, time) ?? baseVal : baseVal;

  const onChange = (v: unknown): void => {
    if (animated && typeof v === 'number') {
      // Reversible keyframe edit. A scrub fires onChange many times for the same
      // (node, prop, time); the merge key collapses them into one undo step.
      runAnimEdit(
        `Set ${propName}`,
        () => defaultAnimation.setKeyframe(nodeId, propName, time, v),
        `set:${nodeId}:${propName}:${time}`,
      );
    } else {
      setBaseVal(v);
    }
  };

  const toggleAnim = (): void => {
    if (animated) {
      runAnimEdit(`Remove ${propName} animation`, () =>
        defaultAnimation.removeTrack(nodeId, propName),
      );
    } else if (numeric) {
      runAnimEdit(`Animate ${propName}`, () =>
        defaultAnimation.setKeyframe(nodeId, propName, time, Number(baseVal)),
      );
    }
  };

  return (
    <InspectorRow label={propName} align="center">
      <div className={styles.control}>
        {numeric ? (
          <button
            type="button"
            className={cn(styles.stopwatch, animated && styles.stopwatchOn)}
            onClick={toggleAnim}
            aria-label={animated ? `Remove ${propName} animation` : `Animate ${propName}`}
            aria-pressed={animated}
            title={animated ? 'Remove animation' : 'Animate (add keyframes)'}
          >
            <Icon name="keyframe" size={11} />
          </button>
        ) : (
          <span className={styles.stopwatchSpacer} />
        )}
        <div className={styles.field}>
          {Editor
            ? Editor({ value: displayVal, onChange, nodeId, componentId, propName })
            : String(displayVal)}
        </div>
      </div>
    </InspectorRow>
  );
}

export function NodeInspector({ nodeId }: { nodeId: string }): JSX.Element {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return <div className={styles.empty}>No node data</div>;

  return (
    <div>
      {node.components.map((comp) => {
        // Hidden (`__`) props and object-valued props are skipped — objects
        // (fills, mask paths, effect stacks…) have dedicated editors and would
        // otherwise render as "[object Object]".
        const props = Object.keys(comp.props ?? {}).filter(
          (p) => !p.startsWith('__') && (typeof comp.props[p] !== 'object' || comp.props[p] === null),
        );
        if (props.length === 0) return null;
        return (
          <div key={comp.id} className={styles.group}>
            <h4 className={styles.groupTitle}>{comp.type}</h4>
            {props.map((p) => (
              <PropertyRow
                key={p}
                nodeId={nodeId}
                componentId={comp.id}
                componentType={comp.type}
                propName={p}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

export default NodeInspector;
