import { getTimelineController } from '@core/timeline/TimelineController';
import { useMemo, useState } from 'react';
import { ValueField } from '@components/ValueField';
import { InspectorRow } from '@components/Inspector';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled } from '@core/scene/threeD';
import { moveAnchorCompensated } from '@core/scene/anchor';
import { readNodeKind } from '@core/scene/sceneDerive';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { Icon } from '@components/Icon';
import styles from './TransformSection.module.css';

export function TransformSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const time = useActiveWorkspace()?.time ?? 0;
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const node = defaultSceneGraph.getNode(nodeId);

  if (!node) return null;

  const tComp = useMemo(() => node.components.find((c) => c.type === 'Transform'), [node]);
  const sComp = useMemo(() => node.components.find((c) => c.type === 'Style' || c.type === 'Text'), [node]);

  const [xVal, setXVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'x');
  const [yVal, setYVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'y');
  const [zVal, setZVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'z');
  const [rotVal, setRotVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'rotation');
  const [scaleXValRaw, setScaleXVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'scaleX');
  const [scaleYValRaw, setScaleYVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'scaleY');
  const scaleXVal = typeof scaleXValRaw === 'number' ? scaleXValRaw : 1;
  const scaleYVal = typeof scaleYValRaw === 'number' ? scaleYValRaw : 1;
  const [rotXVal, setRotXVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'rotationX');
  const [rotYVal, setRotYVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'rotationY');
  const [widthValRaw, setWidthVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'width');
  const [heightValRaw, setHeightVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'height');
  const widthVal = widthValRaw;
  const heightVal = heightValRaw;
  const [anchorXValRaw] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'anchorX');
  const [anchorYValRaw] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'anchorY');
  const anchorXVal = anchorXValRaw ?? 0;
  const anchorYVal = anchorYValRaw ?? 0;
  const [opacityVal, setOpacityVal] = useNodeComponentProp(defaultSceneGraph, nodeId, sComp?.id, 'opacity');
  const [isLinked, setIsLinked] = useState(true);

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
      if ((animated || autoKeyframe) && typeof v === 'number') {
        runAnimEdit(
          `Set ${propName}`,
          () => defaultAnimation.setKeyframe(nodeId, propName, getTimelineController().toLayerTime(nodeId, time), v),
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
          defaultAnimation.setKeyframe(nodeId, propName, getTimelineController().toLayerTime(nodeId, time), Number(value))
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
              title={animated ? 'Disable keyframe animation (delete track)' : 'Enable keyframe animation (animate value over time)'}
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

  const is3D = is3DEnabled(node);
  const isCamera = readNodeKind(node) === 'camera';

  const renderGroupedVectorProp = () => {
    const animatedX = defaultAnimation.isAnimated(nodeId, 'x');
    const animatedY = defaultAnimation.isAnimated(nodeId, 'y');
    const animatedZ = (isCamera || is3D) && defaultAnimation.isAnimated(nodeId, 'z');
    const animated = animatedX || animatedY || animatedZ;

    const displayX = animatedX ? defaultAnimation.sample(nodeId, 'x', time) ?? xVal : xVal;
    const displayY = animatedY ? defaultAnimation.sample(nodeId, 'y', time) ?? yVal : yVal;
    const displayZ = animatedZ ? defaultAnimation.sample(nodeId, 'z', time) ?? zVal : zVal;

    const toggleAnim = () => {
      if (animated) {
        runAnimEdit(`Remove Position animation`, () => {
          defaultAnimation.removeTrack(nodeId, 'x');
          defaultAnimation.removeTrack(nodeId, 'y');
          if (isCamera || is3D) defaultAnimation.removeTrack(nodeId, 'z');
        });
      } else {
        runAnimEdit(`Animate Position`, () => {
          defaultAnimation.setKeyframe(nodeId, 'x', getTimelineController().toLayerTime(nodeId, time), Number(xVal ?? 0));
          defaultAnimation.setKeyframe(nodeId, 'y', getTimelineController().toLayerTime(nodeId, time), Number(yVal ?? 0));
          if (isCamera || is3D) defaultAnimation.setKeyframe(nodeId, 'z', getTimelineController().toLayerTime(nodeId, time), Number(zVal ?? 0));
        });
      }
    };

    return (
      <InspectorRow label="Position" align="center" key="Position">
        <div className={styles.control}>
          <button
            type="button"
            className={`${styles.stopwatch} ${animated ? styles.stopwatchOn : ''}`}
            onClick={toggleAnim}
            title={animated ? 'Disable keyframe animation (delete track)' : 'Enable keyframe animation (animate position over time)'}
          >
            <Icon name="keyframe" size={11} />
          </button>
          <div className={styles.field} style={{ display: 'flex', gap: 'var(--space-1)' }}>
            <ValueField 
              value={Number(displayX ?? 0)} 
              unit="px" 
              onChange={(v) => {
                if ((animatedX || autoKeyframe) && typeof v === 'number') {
                  runAnimEdit('Set Position X', () => defaultAnimation.setKeyframe(nodeId, 'x', getTimelineController().toLayerTime(nodeId, time), v), `set:${nodeId}:x:${time}`);
                } else {
                  setXVal(v);
                  defaultSceneGraph.setLocalTransform(nodeId, { x: v as number, y: (yVal as number) ?? 0, rotation: (rotVal as number) ?? 0, scaleX: scaleXVal, scaleY: scaleYVal });
                }
              }} 
            />
            <ValueField 
              value={Number(displayY ?? 0)} 
              unit="px" 
              onChange={(v) => {
                if ((animatedY || autoKeyframe) && typeof v === 'number') {
                  runAnimEdit('Set Position Y', () => defaultAnimation.setKeyframe(nodeId, 'y', getTimelineController().toLayerTime(nodeId, time), v), `set:${nodeId}:y:${time}`);
                } else {
                  setYVal(v);
                  defaultSceneGraph.setLocalTransform(nodeId, { x: (xVal as number) ?? 0, y: v as number, rotation: (rotVal as number) ?? 0, scaleX: scaleXVal, scaleY: scaleYVal });
                }
              }} 
            />
            {(isCamera || is3D) && (
              <ValueField 
                value={Number(displayZ ?? 0)} 
                unit="px" 
                onChange={(v) => {
                  if ((animatedZ || autoKeyframe) && typeof v === 'number') {
                    runAnimEdit('Set Position Z', () => defaultAnimation.setKeyframe(nodeId, 'z', getTimelineController().toLayerTime(nodeId, time), v), `set:${nodeId}:z:${time}`);
                  } else {
                    setZVal(v);
                  }
                }} 
              />
            )}
          </div>
        </div>
      </InspectorRow>
    );
  };

  // Scale X/Y in one row (linked stopwatch), matching the grouped Position row
  // and After Effects' single Scale property.
  const renderGroupedScale = () => {
    const animatedX = defaultAnimation.isAnimated(nodeId, 'scaleX');
    const animatedY = defaultAnimation.isAnimated(nodeId, 'scaleY');
    const animated = animatedX || animatedY;
    const displayX = animatedX ? defaultAnimation.sample(nodeId, 'scaleX', time) ?? scaleXVal : scaleXVal;
    const displayY = animatedY ? defaultAnimation.sample(nodeId, 'scaleY', time) ?? scaleYVal : scaleYVal;

    const toggleAnim = () => {
      if (animated) {
        runAnimEdit('Remove Scale animation', () => {
          defaultAnimation.removeTrack(nodeId, 'scaleX');
          defaultAnimation.removeTrack(nodeId, 'scaleY');
        });
      } else {
        runAnimEdit('Animate Scale', () => {
          defaultAnimation.setKeyframe(nodeId, 'scaleX', getTimelineController().toLayerTime(nodeId, time), Number(scaleXVal ?? 1));
          defaultAnimation.setKeyframe(nodeId, 'scaleY', getTimelineController().toLayerTime(nodeId, time), Number(scaleYVal ?? 1));
        });
      }
    };

    const setScale = (axis: 'scaleX' | 'scaleY', v: unknown) => {
      const numV = Number(v);
      const otherAxis = axis === 'scaleX' ? 'scaleY' : 'scaleX';
      const setter = axis === 'scaleX' ? setScaleXVal : setScaleYVal;
      const otherSetter = axis === 'scaleX' ? setScaleYVal : setScaleXVal;

      let ratio = 1;
      if (isLinked) {
        const currentThis = axis === 'scaleX' ? (scaleXVal as number) : (scaleYVal as number);
        const currentOther = axis === 'scaleX' ? (scaleYVal as number) : (scaleXVal as number);
        if (currentThis !== 0) {
          ratio = currentOther / currentThis;
        }
      }

      if ((animated || autoKeyframe) && typeof v === 'number') {
        runAnimEdit(`Set Scale`, () => {
          defaultAnimation.setKeyframe(nodeId, axis, getTimelineController().toLayerTime(nodeId, time), v);
          if (isLinked) {
            defaultAnimation.setKeyframe(nodeId, otherAxis, getTimelineController().toLayerTime(nodeId, time), numV * ratio);
          }
        }, `set:${nodeId}:scale:${time}`);
      } else {
        setter(v);
        if (isLinked && typeof v === 'number') {
          otherSetter(numV * ratio);
        }
      }
    };

    return (
      <InspectorRow label="Scale" align="center" key="Scale">
        <div className={styles.control}>
          <button
            type="button"
            className={`${styles.stopwatch} ${animated ? styles.stopwatchOn : ''}`}
            onClick={toggleAnim}
            title={animated ? 'Disable keyframe animation (delete track)' : 'Enable keyframe animation (animate scale over time)'}
          >
            <Icon name="keyframe" size={11} />
          </button>
          <div className={styles.field} style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
            <ValueField value={Number(displayX ?? 1)} unit="x" onChange={(v) => setScale('scaleX', v)} />
            <button
              type="button"
              className={styles.stopwatch}
              onClick={() => setIsLinked(!isLinked)}
              title={isLinked ? 'Unlink Scale X/Y' : 'Link Scale X/Y'}
              style={{ padding: '0 2px', opacity: isLinked ? 1 : 0.4 }}
            >
              <Icon name={isLinked ? 'lock' : 'unlock'} size={12} />
            </button>
            <ValueField value={Number(displayY ?? 1)} unit="x" onChange={(v) => setScale('scaleY', v)} />
          </div>
        </div>
      </InspectorRow>
    );
  };

  const renderGroupedSize = () => {
    if (widthVal === undefined && heightVal === undefined) return null;
    const animatedW = defaultAnimation.isAnimated(nodeId, 'width');
    const animatedH = defaultAnimation.isAnimated(nodeId, 'height');
    const animated = animatedW || animatedH;
    const displayW = animatedW ? defaultAnimation.sample(nodeId, 'width', time) ?? widthVal : widthVal;
    const displayH = animatedH ? defaultAnimation.sample(nodeId, 'height', time) ?? heightVal : heightVal;

    const toggleAnim = () => {
      if (animated) {
        runAnimEdit('Remove Size animation', () => {
          defaultAnimation.removeTrack(nodeId, 'width');
          defaultAnimation.removeTrack(nodeId, 'height');
        });
      } else {
        runAnimEdit('Animate Size', () => {
          defaultAnimation.setKeyframe(nodeId, 'width', getTimelineController().toLayerTime(nodeId, time), Number(widthVal ?? 100));
          defaultAnimation.setKeyframe(nodeId, 'height', getTimelineController().toLayerTime(nodeId, time), Number(heightVal ?? 100));
        });
      }
    };

    return (
      <InspectorRow label="Size" align="center" key="Size">
        <div className={styles.control}>
          <button
            type="button"
            className={`${styles.stopwatch} ${animated ? styles.stopwatchOn : ''}`}
            onClick={toggleAnim}
            title={animated ? 'Disable keyframe animation (delete track)' : 'Enable keyframe animation (animate size over time)'}
          >
            <Icon name="keyframe" size={11} />
          </button>
          <div className={styles.field} style={{ display: 'flex', gap: 'var(--space-1)' }}>
            <ValueField 
              value={Number(displayW ?? 100)} 
              unit="px" 
              onChange={(v) => {
                if ((animatedW || autoKeyframe) && typeof v === 'number') {
                  runAnimEdit('Set Width', () => defaultAnimation.setKeyframe(nodeId, 'width', getTimelineController().toLayerTime(nodeId, time), v), `set:${nodeId}:width:${time}`);
                } else {
                  setWidthVal(v);
                }
              }} 
            />
            <ValueField 
              value={Number(displayH ?? 100)} 
              unit="px" 
              onChange={(v) => {
                if ((animatedH || autoKeyframe) && typeof v === 'number') {
                  runAnimEdit('Set Height', () => defaultAnimation.setKeyframe(nodeId, 'height', getTimelineController().toLayerTime(nodeId, time), v), `set:${nodeId}:height:${time}`);
                } else {
                  setHeightVal(v);
                }
              }} 
            />
          </div>
        </div>
      </InspectorRow>
    );
  };

  const renderGroupedAnchor = () => {
    if (isCamera) return null;
    const animatedX = defaultAnimation.isAnimated(nodeId, 'anchorX');
    const animatedY = defaultAnimation.isAnimated(nodeId, 'anchorY');
    const animated = animatedX || animatedY;
    const displayX = animatedX ? defaultAnimation.sample(nodeId, 'anchorX', time) ?? anchorXVal : anchorXVal;
    const displayY = animatedY ? defaultAnimation.sample(nodeId, 'anchorY', time) ?? anchorYVal : anchorYVal;

    const toggleAnim = () => {
      if (animated) {
        runAnimEdit('Remove Anchor animation', () => {
          defaultAnimation.removeTrack(nodeId, 'anchorX');
          defaultAnimation.removeTrack(nodeId, 'anchorY');
        });
      } else {
        runAnimEdit('Animate Anchor Point', () => {
          defaultAnimation.setKeyframe(nodeId, 'anchorX', getTimelineController().toLayerTime(nodeId, time), Number(anchorXVal ?? 0));
          defaultAnimation.setKeyframe(nodeId, 'anchorY', getTimelineController().toLayerTime(nodeId, time), Number(anchorYVal ?? 0));
        });
      }
    };

    return (
      <InspectorRow label="Anchor Point" align="center" key="Anchor">
        <div className={styles.control}>
          <button
            type="button"
            className={`${styles.stopwatch} ${animated ? styles.stopwatchOn : ''}`}
            onClick={toggleAnim}
            title={animated ? 'Disable keyframe animation (delete track)' : 'Enable keyframe animation (animate anchor point over time)'}
          >
            <Icon name="keyframe" size={11} />
          </button>
          <div className={styles.field} style={{ display: 'flex', gap: 'var(--space-1)' }}>
            <ValueField 
              value={Number(displayX ?? 0)} 
              unit="px" 
              onChange={(v) => {
                if ((animatedX || autoKeyframe) && typeof v === 'number') {
                  runAnimEdit('Set Anchor X', () => defaultAnimation.setKeyframe(nodeId, 'anchorX', getTimelineController().toLayerTime(nodeId, time), v), `set:${nodeId}:anchorX:${time}`);
                } else if (typeof v === 'number') {
                  // Pan-behind: compensate position so the layer stays visually put.
                  moveAnchorCompensated(nodeId, v, Number(anchorYVal));
                }
              }}
            />
            <ValueField 
              value={Number(displayY ?? 0)} 
              unit="px" 
              onChange={(v) => {
                if ((animatedY || autoKeyframe) && typeof v === 'number') {
                  runAnimEdit('Set Anchor Y', () => defaultAnimation.setKeyframe(nodeId, 'anchorY', getTimelineController().toLayerTime(nodeId, time), v), `set:${nodeId}:anchorY:${time}`);
                } else if (typeof v === 'number') {
                  // Pan-behind: compensate position so the layer stays visually put.
                  moveAnchorCompensated(nodeId, Number(anchorXVal), v);
                }
              }}
            />
          </div>
        </div>
      </InspectorRow>
    );
  };

  return (
    <div className={styles.section}>
      <h4 className={styles.title}>Transform</h4>
      {renderGroupedAnchor()}
      {tComp.props.separateDimensions ? (
        <>
          {renderAnimProp('Position X', 'x', xVal ?? 0, setXVal, 'px')}
          {renderAnimProp('Position Y', 'y', yVal ?? 0, setYVal, 'px')}
          {(isCamera || is3D) && renderAnimProp('Position Z', 'z', zVal ?? 0, setZVal, 'px')}
        </>
      ) : (
        renderGroupedVectorProp()
      )}
      {renderGroupedScale()}
      {renderAnimProp('Rotation', 'rotation', rotVal ?? 0, setRotVal, '°')}
      {is3D && (
        <>
          {renderAnimProp('Rotation X', 'rotationX', rotXVal ?? 0, setRotXVal, '°')}
          {renderAnimProp('Rotation Y', 'rotationY', rotYVal ?? 0, setRotYVal, '°')}
        </>
      )}
      {renderGroupedSize()}
      {sComp && renderAnimProp('Opacity', 'opacity', opacityVal ?? 100, setOpacityVal, '%')}
    </div>
  );
}

export default TransformSection;
