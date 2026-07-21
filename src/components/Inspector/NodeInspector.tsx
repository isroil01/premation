import { InspectorRow } from './Inspector';
import { propertyRegistry } from '@core/inspector/PropertyRegistry';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { useActiveWorkspace } from '@stores/projectStore';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { useSceneRevision } from '@stores/sceneStore';
import { Color } from '@motion/renderer';


import styles from './NodeInspector.module.css';
import { Checkbox } from '../Checkbox';

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
  const rawTime = useActiveWorkspace()?.time ?? 0;
  // Already layer-local: this is the axis the renderer samples on, and the
  // axis every write below must use. Calling toLayerTime on top of it
  // subtracted the clip start twice (the ghost-drag bug's root cause).
  const time = getRemappedTime(nodeId, rawTime);
  // Subscribe to the revision so the row re-renders on keyframe/scene changes.
  useSceneRevision((s) => s.rev);

  const Editor = propertyRegistry.get(componentType, propName);
  const numeric = typeof baseVal === 'number';
  const isColor = typeof baseVal === 'string' && baseVal.startsWith('#');
  
  let animated = false;
  let displayVal = baseVal;

  if (numeric) {
    animated = defaultAnimation.isAnimated(nodeId, propName);
    displayVal = animated ? defaultAnimation.sample(nodeId, propName, time) ?? baseVal : baseVal;
  } else if (isColor) {
    animated = defaultAnimation.isAnimated(nodeId, `${propName}_r`);
    if (animated) {
      const r = defaultAnimation.sample(nodeId, `${propName}_r`, time) ?? 0;
      const g = defaultAnimation.sample(nodeId, `${propName}_g`, time) ?? 0;
      const b = defaultAnimation.sample(nodeId, `${propName}_b`, time) ?? 0;
      const a = defaultAnimation.sample(nodeId, `${propName}_a`, time) ?? 1;
      displayVal = Color.toHex({ r, g, b, a });
    }
  }

  const onChange = (v: unknown): void => {
    if (animated && typeof v === 'number') {
      // Reversible keyframe edit. A scrub fires onChange many times for the same
      // (node, prop, time); the merge key collapses them into one undo step.
      runAnimEdit(
        `Set ${propName}`,
        () => defaultAnimation.setKeyframe(nodeId, propName, time, v),
        `set:${nodeId}:${propName}:${time}`,
      );
    } else if (animated && isColor && typeof v === 'string') {
      const c = Color.fromHex(v);
      runAnimEdit(
        `Set ${propName}`,
        () => {
          defaultAnimation.setKeyframe(nodeId, `${propName}_r`, time, c.r);
          defaultAnimation.setKeyframe(nodeId, `${propName}_g`, time, c.g);
          defaultAnimation.setKeyframe(nodeId, `${propName}_b`, time, c.b);
          defaultAnimation.setKeyframe(nodeId, `${propName}_a`, time, c.a);
        },
        `set:${nodeId}:${propName}:${time}`,
      );
    } else {
      setBaseVal(v);
    }
  };

  const toggleAnim = (): void => {
    if (animated) {
      if (numeric) {
        runAnimEdit(`Remove ${propName} animation`, () =>
          defaultAnimation.removeTrack(nodeId, propName),
        );
      } else if (isColor) {
        runAnimEdit(`Remove ${propName} animation`, () => {
          defaultAnimation.removeTrack(nodeId, `${propName}_r`);
          defaultAnimation.removeTrack(nodeId, `${propName}_g`);
          defaultAnimation.removeTrack(nodeId, `${propName}_b`);
          defaultAnimation.removeTrack(nodeId, `${propName}_a`);
        });
      }
    } else if (numeric) {
      runAnimEdit(`Animate ${propName}`, () =>
        defaultAnimation.setKeyframe(nodeId, propName, time, Number(baseVal)),
      );
    } else if (isColor) {
      const c = Color.fromHex(String(baseVal));
      runAnimEdit(`Animate ${propName}`, () => {
        defaultAnimation.setKeyframe(nodeId, `${propName}_r`, time, c.r);
        defaultAnimation.setKeyframe(nodeId, `${propName}_g`, time, c.g);
        defaultAnimation.setKeyframe(nodeId, `${propName}_b`, time, c.b);
        defaultAnimation.setKeyframe(nodeId, `${propName}_a`, time, c.a);
      });
    }
  };

  return (
    <InspectorRow label={propName} align="center">
      <div className={styles.control}>
        {numeric || isColor ? (
          <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
          <Checkbox 
            checked={animated} 
            onChange={toggleAnim} 
            title="Toggle Animation"
            style={{ width: 14, height: 14 }}
          />
        </div>
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
          (p) => !p.startsWith('__') && (typeof comp.props[p] !== 'object' || comp.props[p] === null) &&
                 !(comp.type === 'Transform' && ['x', 'y', 'z', 'rotation', 'rotationX', 'rotationY', 'scaleX', 'scaleY', 'width', 'height', 'anchorX', 'anchorY'].includes(p)),
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
