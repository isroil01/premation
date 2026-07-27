import { Icon } from '@components/Icon';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { useMemo, useState } from 'react';
import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled } from '@core/scene/threeD';
import { moveAnchorCompensated } from '@core/scene/anchor';
import { readNodeKind } from '@core/scene/sceneDerive';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { Checkbox } from '@components/Checkbox';
import { AngleDial } from '@components/AngleDial';

import styles from './TransformSection.module.css';

/** Rotation-flavored props get a purpose-built dial next to their number —
 *  the dial writes through the SAME handleChange as the ValueField, so
 *  keyframing/auto-key behaviour is identical. */
const ROTATION_PROPS = new Set([
  'rotation',
  'rotationX',
  'rotationY',
  'orientationX',
  'orientationY',
  'orientationZ',
]);

export function TransformSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  // Every field here can show a sampled keyframe value, and keyframes live in
  // the AnimationEngine rather than a store — without this the panel keeps
  // displaying the value it last rendered with after you edit one.
  useAnimationRevision();
  const time = useActiveWorkspace()?.time ?? 0;
  // The layer's own time axis — the one the renderer samples on. Every read and
  // every write in this panel goes through it, so what you see is what renders.
  const layerT = getRemappedTime(nodeId, time);
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const node = defaultSceneGraph.getNode(nodeId);
  const [linkedScale, setLinkedScale] = useState(true);

  // NO early return before the hooks below. `if (!node) return null` used to sit
  // here, above ~22 more hooks (two useMemo + twenty useNodeComponentProp), so
  // selecting a layer whose node lookup misses — or deselecting while this panel
  // stays mounted — changed the hook count between renders and React threw
  // "Rendered fewer hooks than expected", taking the whole Properties tab down.
  // The hooks all tolerate `undefined` ids; the render guard moved below them.
  const tComp = useMemo(() => node?.components.find((c) => c.type === 'Transform'), [node]);
  const sComp = useMemo(() => node?.components.find((c) => c.type === 'Style' || c.type === 'Text'), [node]);

  const [xValRaw, setXVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'x');
  const [yValRaw, setYVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'y');
  const [zValRaw, setZVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'z');
  const [rotValRaw, setRotVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'rotation');
  const [scaleXValRaw, setScaleXVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'scaleX');
  const [scaleYValRaw, setScaleYVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'scaleY');
  const scaleXVal = typeof scaleXValRaw === 'number' ? scaleXValRaw : 1;
  const scaleYVal = typeof scaleYValRaw === 'number' ? scaleYValRaw : 1;
  const [rotXValRaw, setRotXVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'rotationX');
  const [rotYValRaw, setRotYVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'rotationY');
  const [oriXRaw, setOriX] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'orientationX');
  const [oriYRaw, setOriY] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'orientationY');
  const [oriZRaw, setOriZ] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'orientationZ');
  const [anchorZRaw, setAnchorZ] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'anchorZ');
  const oriXVal = typeof oriXRaw === 'number' ? oriXRaw : 0;
  const oriYVal = typeof oriYRaw === 'number' ? oriYRaw : 0;
  const oriZVal = typeof oriZRaw === 'number' ? oriZRaw : 0;
  const anchorZVal = typeof anchorZRaw === 'number' ? anchorZRaw : 0;
  const [widthValRaw, setWidthVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'width');
  const [heightValRaw, setHeightVal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'height');
  const widthVal = typeof widthValRaw === 'number' ? widthValRaw : undefined;
  const heightVal = typeof heightValRaw === 'number' ? heightValRaw : undefined;
  const [anchorXValRaw] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'anchorX');
  const [anchorYValRaw] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'anchorY');
  const anchorXVal = typeof anchorXValRaw === 'number' ? anchorXValRaw : 0;
  const anchorYVal = typeof anchorYValRaw === 'number' ? anchorYValRaw : 0;
  const [opacityValRaw, setOpacityVal] = useNodeComponentProp(defaultSceneGraph, nodeId, sComp?.id, 'opacity');

  const xVal = typeof xValRaw === 'number' ? xValRaw : 0;
  const yVal = typeof yValRaw === 'number' ? yValRaw : 0;
  const zVal = typeof zValRaw === 'number' ? zValRaw : 0;
  const rotVal = typeof rotValRaw === 'number' ? rotValRaw : 0;
  const rotXVal = typeof rotXValRaw === 'number' ? rotXValRaw : 0;
  const rotYVal = typeof rotYValRaw === 'number' ? rotYValRaw : 0;
  const opacityVal = typeof opacityValRaw === 'number' ? opacityValRaw : 100;

  // Single render guard, AFTER every hook — so the hook order is identical on
  // every render regardless of what is selected.
  if (!node || !tComp) return null;

  const renderAnimPropInner = (
    label: string,
    propName: string,
    value: number,
    setVal: (v: number) => void,
    unit = '',
    resetVal?: number
  ) => {
    const numeric = typeof value === 'number';
    const animated = numeric && defaultAnimation.isAnimated(nodeId, propName);
    // Sample on the SAME axis we write to. This used to sample the raw comp
    // time while writing at the layer time, so on a layer whose clip does not
    // start at 0 the field showed a point somewhere along the curve instead of
    // the keyframe you set — and typing there "corrected" it, which read as the
    // later keyframe overwriting the earlier one.
    const displayVal = animated ? defaultAnimation.sample(nodeId, propName, layerT) ?? value : value;

    const handleChange = (v: unknown) => {
      const valNum = Number(v);
      if ((animated || autoKeyframe) && typeof v === 'number') {
        runAnimEdit(
          `Set ${propName}`,
          () => {
            defaultAnimation.setKeyframe(nodeId, propName, layerT, valNum);
            if (linkedScale && (propName === 'scaleX' || propName === 'scaleY')) {
              const otherProp = propName === 'scaleX' ? 'scaleY' : 'scaleX';
              defaultAnimation.setKeyframe(nodeId, otherProp, layerT, valNum);
            }
          },
          `set:${nodeId}:${propName}:${layerT}`
        );
      } else {
        setVal(valNum);
        if (linkedScale && (propName === 'scaleX' || propName === 'scaleY')) {
          if (propName === 'scaleX') setScaleYVal(valNum);
          else setScaleXVal(valNum);
        }
        if (propName === 'x' || propName === 'y' || propName === 'rotation') {
          const currentX = propName === 'x' ? valNum : xVal;
          const currentY = propName === 'y' ? valNum : yVal;
          const currentRot = propName === 'rotation' ? valNum : rotVal;
          defaultSceneGraph.setLocalTransform(nodeId, { x: currentX, y: currentY, rotation: currentRot });
        }
      }
    };

    return (
      <div className={styles.popoverRow} key={propName}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
          {numeric && (
            <Checkbox
              checked={animated}
              onChange={() => {
                if (animated) {
                  runAnimEdit(`Remove ${propName} animation`, () =>
                    defaultAnimation.removeTrack(nodeId, propName)
                  );
                } else {
                  runAnimEdit(`Animate ${propName}`, () =>
                    defaultAnimation.setKeyframe(nodeId, propName, layerT, Number(value))
                  );
                }
              }}
              title="Toggle Keyframes"
              style={{ width: 13, height: 13 }}
            />
          )}
          <span className={styles.popoverLabel}>
            {label.replace(/(Position|Scale|Rotation|Anchor Point)\s*/i, '') || label}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {/* Rotation rows: AE-style dial (drag = rotate, Shift snaps 15°,
              winds through revolutions) sharing the row's write path. */}
          {ROTATION_PROPS.has(propName) && (
            <AngleDial
              value={Number(displayVal ?? 0)}
              onChange={handleChange}
              aria-label={`${label} dial`}
            />
          )}
          {/* The visible label is stripped to "X"/"Y" under a group header, so
              several rows read identically; the field carries the full name for
              screen readers (and anything else addressing it by name). */}
          <ValueField
            value={Number(displayVal ?? 0)}
            unit={unit}
            onChange={handleChange}
            aria-label={label}
          />
          {resetVal !== undefined && (
            <button
              type="button"
              title={`Reset ${label}`}
              onClick={() => handleChange(resetVal)}
              className={styles.resetBtn}
            >
              <Icon name="rotate" size={10} />
            </button>
          )}
        </div>
      </div>
    );
  };

  // Render a stopwatch icon button directly on a grid cell (outside popover).
  // Each prop carries ITS OWN current value — keying every prop to a single
  // shared value made "Enable animation" on Position write y := x (the layer
  // visibly jumped the moment the stopwatch was clicked).
  const renderStopwatchBtn = (props: Array<{ prop: string; value: number }>) => {
    const animated = props.some(({ prop }) => defaultAnimation.isAnimated(nodeId, prop));
    return (
      <button
        type="button"
        className={`${styles.stopwatch} ${animated ? styles.stopwatchOn : ''}`}
        title={animated ? 'Remove animation (delete keyframes)' : 'Enable animation (create first keyframe)'}
        onClick={(e) => {
          e.stopPropagation();
          if (animated) {
            runAnimEdit('Remove animation', () => {
              for (const { prop } of props) defaultAnimation.removeTrack(nodeId, prop);
            });
          } else {
            runAnimEdit('Enable animation', () => {
              for (const { prop, value } of props) {
                defaultAnimation.setKeyframe(nodeId, prop, layerT, value);
              }
            });
          }
        }}
        aria-label={animated ? 'Disable animation' : 'Enable animation'}
      >
        <Icon name="stopwatch" size={11} />
      </button>
    );
  };

  const is3D = is3DEnabled(node);
  const isCamera = readNodeKind(node) === 'camera';

  // Check if any sub-property is animated for visual indicator dot
  const isAnchorAnimated = defaultAnimation.isAnimated(nodeId, 'anchorX') || defaultAnimation.isAnimated(nodeId, 'anchorY');
  const isPositionAnimated = defaultAnimation.isAnimated(nodeId, 'x') || defaultAnimation.isAnimated(nodeId, 'y') || defaultAnimation.isAnimated(nodeId, 'z');
  const isScaleAnimated = defaultAnimation.isAnimated(nodeId, 'scaleX') || defaultAnimation.isAnimated(nodeId, 'scaleY');
  const isRotationAnimated = defaultAnimation.isAnimated(nodeId, 'rotation') || defaultAnimation.isAnimated(nodeId, 'rotationX') || defaultAnimation.isAnimated(nodeId, 'rotationY');
  const isSizeAnimated = defaultAnimation.isAnimated(nodeId, 'width') || defaultAnimation.isAnimated(nodeId, 'height');
  const isOpacityAnimated = defaultAnimation.isAnimated(nodeId, 'opacity');

  // AE-style flat property list: a subhead per group (label · animated dot ·
  // stopwatch), then its rows inline — no popovers, everything one glance away.
  const subhead = (label: string, animated: boolean, stopwatch: JSX.Element | null) => (
    <div className={styles.subhead}>
      {label}
      {animated && <span className={styles.animatedDot} />}
      <span style={{ flex: 1 }} />
      {stopwatch}
    </div>
  );

  return (
    <div className={styles.section}>
      <h4 className={styles.title}>Transform</h4>

      <div className={styles.inlineRows}>
        {!isCamera && (
          <>
            {subhead('Anchor', isAnchorAnimated, renderStopwatchBtn([
              { prop: 'anchorX', value: anchorXVal },
              { prop: 'anchorY', value: anchorYVal },
            ]))}
            {renderAnimPropInner('Anchor Point X', 'anchorX', anchorXVal, (v) => {
              moveAnchorCompensated(nodeId, v, anchorYVal);
            }, 'px', 0)}
            {renderAnimPropInner('Anchor Point Y', 'anchorY', anchorYVal, (v) => {
              moveAnchorCompensated(nodeId, anchorXVal, v);
            }, 'px', 0)}
            {is3D && renderAnimPropInner('Anchor Point Z', 'anchorZ', anchorZVal, (v) => setAnchorZ(v), 'px', 0)}
          </>
        )}

        {subhead('Position', isPositionAnimated, renderStopwatchBtn([
          { prop: 'x', value: xVal },
          { prop: 'y', value: yVal },
          ...(isCamera || is3D ? [{ prop: 'z', value: zVal }] : []),
        ]))}
        {renderAnimPropInner('Position X', 'x', xVal, (v) => setXVal(v), 'px', 0)}
        {renderAnimPropInner('Position Y', 'y', yVal, (v) => setYVal(v), 'px', 0)}
        {(isCamera || is3D) && renderAnimPropInner('Position Z', 'z', zVal, (v) => setZVal(v), 'px', 0)}

        <div className={styles.subhead}>
          <span>Scale</span>
          <button
            type="button"
            onClick={() => setLinkedScale(!linkedScale)}
            className={`${styles.lockBtn} ${linkedScale ? styles.lockBtnActive : ''}`}
            title={linkedScale ? 'Unlink Scale dimensions' : 'Link Scale dimensions (Uniform Zoom)'}
            style={{ marginLeft: 6 }}
          >
            <Icon name={linkedScale ? 'lock' : 'unlock'} size={10} />
          </button>
          {isScaleAnimated && <span className={styles.animatedDot} />}
          <span style={{ flex: 1 }} />
          {renderStopwatchBtn([
            { prop: 'scaleX', value: scaleXVal },
            { prop: 'scaleY', value: scaleYVal },
          ])}
        </div>
        {renderAnimPropInner('Scale X', 'scaleX', scaleXVal, (v) => setScaleXVal(v), 'x', 1)}
        {renderAnimPropInner('Scale Y', 'scaleY', scaleYVal, (v) => setScaleYVal(v), 'x', 1)}

        {subhead('Rotation', isRotationAnimated, renderStopwatchBtn([
          { prop: 'rotation', value: rotVal },
          ...(is3D
            ? [
                { prop: 'rotationX', value: rotXVal },
                { prop: 'rotationY', value: rotYVal },
              ]
            : []),
        ]))}
        {renderAnimPropInner('Rotation', 'rotation', rotVal, (v) => setRotVal(v), '°', 0)}
        {is3D && (
          <>
            {renderAnimPropInner('Rotation X', 'rotationX', rotXVal, (v) => setRotXVal(v), '°', 0)}
            {renderAnimPropInner('Rotation Y', 'rotationY', rotYVal, (v) => setRotYVal(v), '°', 0)}
            {renderAnimPropInner('Orientation X', 'orientationX', oriXVal, (v) => setOriX(v), '°', 0)}
            {renderAnimPropInner('Orientation Y', 'orientationY', oriYVal, (v) => setOriY(v), '°', 0)}
            {renderAnimPropInner('Orientation Z', 'orientationZ', oriZVal, (v) => setOriZ(v), '°', 0)}
          </>
        )}

        {widthVal !== undefined && heightVal !== undefined && (
          <>
            {subhead('Size', isSizeAnimated, renderStopwatchBtn([
              { prop: 'width', value: widthVal },
              { prop: 'height', value: heightVal },
            ]))}
            {renderAnimPropInner('Width', 'width', widthVal, (v) => setWidthVal(v), 'px')}
            {renderAnimPropInner('Height', 'height', heightVal, (v) => setHeightVal(v), 'px')}
          </>
        )}

        {sComp && (
          <>
            {subhead('Opacity', isOpacityAnimated, renderStopwatchBtn([{ prop: 'opacity', value: opacityVal }]))}
            {renderAnimPropInner('Opacity', 'opacity', opacityVal, (v) => setOpacityVal(v), '%', 100)}
          </>
        )}
      </div>
    </div>
  );
}

export default TransformSection;
