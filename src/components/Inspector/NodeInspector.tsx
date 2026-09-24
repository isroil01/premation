import { InspectorRow } from './Inspector';
import { propertyRegistry } from './PropertyRegistry';
import { useMemo } from 'react';
import { secondsToFlicks } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useActiveWorkspace } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorTrackWatch } from '@hooks/useMirror';
import { isTrackAnimated, readTrack, trackRef as mirrorTrackRef } from '@core/mirror/selection';
import { colorValueHex } from '@core/mirror/paintFields';
import { useComponentProp } from '@layout/Inspector/useComponentProp';
import { stopwatchCommands, trackRef, valueCommands } from '@layout/Inspector/inspectorEdits';
import { useEngineEdit } from '@layout/Inspector/useEngineEdit';
import { usePreferenceStore } from '@stores/preferenceStore';
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
 *
 * B3z: every write goes through the engine API. A numeric prop or a colour the
 * catalog addresses (stored numbers with property metadata, the latent numbers
 * of latentPropSpecs.ts, a layer's fill colour, a stroke colour…) writes
 * `valueCommands` (a key at the playhead where animated / under auto-keyframe)
 * and has a stopwatch (`setAnimated`); any other prop writes through
 * `useComponentProp` (a field, or refused with a toast when the engine gives
 * it no meaning — then the row has no stopwatch either).
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
  // B4: re-render when this prop's property (info, keys, value) changes in the document mirror.
  const watchIds = useMemo(() => [nodeId], [nodeId]);
  const watchTracks = useMemo(() => [propName, `${propName}_r`], [propName]);
  useMirrorTrackWatch(watchIds, watchTracks);
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);

  const Editor = propertyRegistry.get(componentType, propName);
  const numeric = typeof baseVal === 'number';
  const isColor = typeof baseVal === 'string' && baseVal.startsWith('#');
  
  let animated = false;
  let displayVal = baseVal;

  // Display only: the value at the playhead (comp time) when animated.
  const m = documentMirror();
  if (numeric) {
    animated = isTrackAnimated(m, nodeId, propName);
    displayVal = animated ? readTrack(m, nodeId, propName, rawTime) ?? baseVal : baseVal;
  } else if (isColor) {
    animated = isTrackAnimated(m, nodeId, `${propName}_r`);
    if (animated) {
      const colorRef = mirrorTrackRef(m, nodeId, `${propName}_r`);
      displayVal = (colorRef ? colorValueHex(m.valueAt(nodeId, colorRef.path, secondsToFlicks(rawTime))) : undefined) ?? baseVal;
    }
  }

  // B3: a numeric prop / colour the engine's catalog addresses goes through the
  // API (value, key at the playhead, stopwatch). The rest keep the legacy key
  // writers below (engine gap: props outside the catalog, e.g. a Style fill).
  const engineTrack = numeric ? propName : isColor ? `${propName}_r` : null;
  const ref = engineTrack ? trackRef(nodeId, engineTrack) : null;
  const onEngine = ref !== null && (numeric ? ref.valueType !== 'color' : ref.valueType === 'color');

  const onChange = (v: unknown): void => {
    if (onEngine) {
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
    // A field, or a prop the engine gives no meaning (useComponentProp refuses it with a toast).
    setBaseVal(v);
  };

  const toggleAnim = (): void => {
    if (onEngine && engineTrack) {
      e.send(animated ? `Remove ${propName} animation` : `Animate ${propName}`, stopwatchCommands([nodeId], [engineTrack], rawTime));
    }
  };

  return (
    <InspectorRow label={propName} align="center">
      <div className={styles.control}>
        {(numeric || isColor) && onEngine ? (
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
  // B4-gap: the raw component list (every component's stored props) — the API addresses properties, not
  // components; this generic list has no mirror form.
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
