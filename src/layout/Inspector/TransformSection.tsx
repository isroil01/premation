import { useMemo } from 'react';
import { ValueField } from '@components/ValueField';
import { InspectorRow } from '@components/Inspector';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { useActiveWorkspace } from '@stores/workspaceStore';
import { Icon } from '@components/Icon';
import styles from './TransformSection.module.css';

export function TransformSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const time = useActiveWorkspace()?.time ?? 0;
  const node = defaultSceneGraph.getNode(nodeId);

  if (!node) return null;

  const tComp = useMemo(() => node.components.find((c) => c.type === 'Transform'), [node]);
  const sComp = useMemo(() => node.components.find((c) => c.type === 'Style' || c.type === 'Text'), [node]);

  const [xVal, setXVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'x');
  const [yVal, setYVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'y');
  const [zVal, setZVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'z');
  const [rotVal, setRotVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'rotation');
  const [scaleXVal, setScaleXVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'scaleX');
  const [scaleYVal, setScaleYVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'scaleY');
  const [opacityVal, setOpacityVal] = useNodeComponentProp(defaultSceneGraph, nodeId, sComp?.id, 'opacity');

  if (!tComp) return null;

  const renderAnimProp = (
    label: string,
    propName: string,
    value: unknown,
    setVal: (v: unknown) => void,
    unit = ''
  ) => {
    const numeric = typeof value === 'number';
    const animated = numeric && defaultAnimation.isAnimated(nodeId, propName);
    const displayVal = animated ? defaultAnimation.sample(nodeId, propName, time) ?? value : value;

    const handleChange = (v: unknown) => {
      if (animated && typeof v === 'number') {
        runAnimEdit(
          `Set ${propName}`,
          () => defaultAnimation.setKeyframe(nodeId, propName, time, v),
          `set:${nodeId}:${propName}:${time}`
        );
      } else {
        setVal(v);
        // Also update local transform on the scene node if x/y/rotation
        if (propName === 'x' || propName === 'y' || propName === 'rotation') {
          const currentX = propName === 'x' ? (v as number) : (typeof xVal === 'number' ? xVal : 0);
          const currentY = propName === 'y' ? (v as number) : (typeof yVal === 'number' ? yVal : 0);
          const currentRot = propName === 'rotation' ? (v as number) : (typeof rotVal === 'number' ? rotVal : 0);
          defaultSceneGraph.setLocalTransform(nodeId, { x: currentX, y: currentY, rotation: currentRot });
        }
      }
    };

    const toggleAnim = () => {
      if (animated) {
        runAnimEdit(`Remove ${propName} animation`, () =>
          defaultAnimation.removeTrack(nodeId, propName)
        );
      } else if (numeric) {
        runAnimEdit(`Animate ${propName}`, () =>
          defaultAnimation.setKeyframe(nodeId, propName, time, Number(value))
        );
      }
    };

    return (
      <InspectorRow label={label} align="center" key={propName}>
        <div className={styles.control}>
          {numeric ? (
            <button
              type="button"
              className={`${styles.stopwatch} ${animated ? styles.stopwatchOn : ''}`}
              onClick={toggleAnim}
              title={animated ? 'Remove animation' : 'Animate'}
            >
              <Icon name="keyframe" size={11} />
            </button>
          ) : (
            <span className={styles.stopwatchSpacer} />
          )}
          <div className={styles.field}>
            <ValueField value={Number(displayVal ?? 0)} unit={unit} onChange={handleChange} />
          </div>
        </div>
      </InspectorRow>
    );
  };

  const isCamera = node.components.some((c) => c.props.__kind === 'camera' || c.id.startsWith('camera'));

  return (
    <div className={styles.section}>
      <h4 className={styles.title}>Transform</h4>
      {renderAnimProp('Position X', 'x', xVal ?? 0, setXVal, 'px')}
      {renderAnimProp('Position Y', 'y', yVal ?? 0, setYVal, 'px')}
      {isCamera && renderAnimProp('Position Z', 'z', zVal ?? 0, setZVal, 'px')}
      {renderAnimProp('Rotation', 'rotation', rotVal ?? 0, setRotVal, '°')}
      {renderAnimProp('Scale X', 'scaleX', scaleXVal ?? 1, setScaleXVal, 'x')}
      {renderAnimProp('Scale Y', 'scaleY', scaleYVal ?? 1, setScaleYVal, 'x')}
      {sComp && renderAnimProp('Opacity', 'opacity', opacityVal ?? 100, setOpacityVal, '%')}
    </div>
  );
}

export default TransformSection;
