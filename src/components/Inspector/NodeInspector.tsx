import { InspectorRow } from './Inspector';
import { propertyRegistry } from './PropertyRegistry';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useActiveWorkspace } from '@stores/projectStore';
import { useComponentProp } from '@layout/Inspector/useComponentProp';
import { stopwatchCommands, trackRef, valueCommands } from '@layout/Inspector/inspectorEdits';
import { useEngineEdit } from '@layout/Inspector/useEngineEdit';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { useSceneRevision } from '@stores/sceneStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import { resolveChannelColor } from '@core/effects/effects';
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
  const [baseVal, setBaseVal] = useComponentProp(nodeId, componentId, propName);
  const e = useEngineEdit();
  const rawTime = useActiveWorkspace()?.time ?? 0;
  // Already layer-local: this is the axis the renderer samples on, and the
  // axis the legacy writes below use. Calling toLayerTime on top of it
  // subtracted the clip start twice (the ghost-drag bug's root cause).
  // B3-legacy: display read + the legacy key axis; the engine route takes comp time.
  const time = compToKeyframeTime(nodeId, rawTime, propName);
  // Subscribe to the revision so the row re-renders on keyframe/scene changes.
  useSceneRevision((s) => s.rev);
  useAnimationRevision();
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);

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
      displayVal = resolveChannelColor(String(baseVal), (suffix) =>
        defaultAnimation.sample(nodeId, `${propName}${suffix}`, time),
      );
    }
  }

  // B3: a numeric prop / colour the engine's catalog addresses goes through the
  // API (value, key at the playhead, stopwatch). The rest keep the legacy key
  // writers below (engine gap: props outside the catalog, e.g. a Style fill).
  const engineTrack = numeric ? propName : isColor ? `${propName}_r` : null;
  const ref = engineTrack ? trackRef(nodeId, engineTrack) : null;
  const onEngine = ref !== null && (numeric ? ref.valueType !== 'color' : ref.valueType === 'color');

  const onChange = (v: unknown): void => {
    if (onEngine && (animated || autoKeyframe)) {
      const vals: Record<string, number> | null = typeof v === 'number'
        ? { [propName]: v }
        : typeof v === 'string' && isColor
          ? (() => { const c = Color.fromHex(v); return { [`${propName}_r`]: c.r, [`${propName}_g`]: c.g, [`${propName}_b`]: c.b, [`${propName}_a`]: c.a ?? 1 }; })()
          : null;
      if (vals) {
        e.send(`Set ${propName}`, valueCommands([{ nodeId, values: vals }], { seconds: rawTime, autoKeyframe }));
        return;
      }
    }
    if ((animated || autoKeyframe) && typeof v === 'number') {
      // B3-legacy: engine gap — a numeric component prop outside the catalog.
      // Reversible keyframe edit. A scrub fires onChange many times for the same
      // (node, prop, time); the merge key collapses them into one undo step.
      runAnimEdit(
        `Set ${propName}`,
        () => defaultAnimation.setKeyframe(nodeId, propName, time, v),
        `set:${nodeId}:${propName}:${time}`,
      );
    } else if ((animated || autoKeyframe) && isColor && typeof v === 'string') {
      // B3-legacy: engine gap — a colour outside the catalog (a layer's own Style fill).
      const c = Color.fromHex(v);
      runAnimEdit(
        `Set ${propName}`,
        () => {
          defaultAnimation.setKeyframe(nodeId, `${propName}_r`, time, c.r);
          // B3-legacy: engine gap — generic component props / colours outside the catalog (e.g. Style fill) keep the legacy key writers.
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
    if (onEngine && engineTrack) {
      e.send(animated ? `Remove ${propName} animation` : `Animate ${propName}`, stopwatchCommands([nodeId], [engineTrack], rawTime));
      return;
    }
    // B3-legacy: engine gap — same (props / colours outside the catalog).
    if (animated) {
      if (numeric) {
        runAnimEdit(`Remove ${propName} animation`, () =>
          defaultAnimation.removeTrack(nodeId, propName),
        );
      } else if (isColor) {
        // B3-legacy: engine gap — generic component props / colours outside the catalog (e.g. Style fill) keep the legacy key writers.
        runAnimEdit(`Remove ${propName} animation`, () => {
          defaultAnimation.removeTrack(nodeId, `${propName}_r`);
          defaultAnimation.removeTrack(nodeId, `${propName}_g`);
          defaultAnimation.removeTrack(nodeId, `${propName}_b`);
          defaultAnimation.removeTrack(nodeId, `${propName}_a`);
        });
      }
    } else if (numeric) {
      // B3-legacy: engine gap — generic component props / colours outside the catalog (e.g. Style fill) keep the legacy key writers.
      runAnimEdit(`Animate ${propName}`, () =>
        defaultAnimation.setKeyframe(nodeId, propName, time, Number(baseVal)),
      );
    } else if (isColor) {
      const c = Color.fromHex(String(baseVal));
      // B3-legacy: engine gap — generic component props / colours outside the catalog (e.g. Style fill) keep the legacy key writers.
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
