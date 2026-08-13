import { Icon } from '@components/Icon';
import { getRemappedTime, keyframeToCompTime } from '@core/timeline/TimelineController';
import { useMemo, useState } from 'react';
import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled } from '@core/scene/threeD';
import { setAnchor } from '@core/scene/anchor';
import { readNodeKind } from '@core/scene/sceneDerive';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { PropertyRow } from '@components/PropertyRow';
import { buildPropertyMenu } from '@core/inspector/propertyMenu';
import { openContextMenu } from '@stores/contextMenuStore';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import { useActiveWorkspace, useProjectStore } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useCompositionStore } from '@stores/compositionStore';
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
  const fps = useCompositionStore((c) => c.fps) || 30;
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
  const [skewRaw, setSkew] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'skew');
  const [skewAxisRaw, setSkewAxis] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'skewAxis');
  const skewVal = typeof skewRaw === 'number' ? skewRaw : 0;
  const skewAxisVal = typeof skewAxisRaw === 'number' ? skewAxisRaw : 0;
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
  const [fillOpacityRaw, setFillOpacity] = useNodeComponentProp(defaultSceneGraph, nodeId, sComp?.id, 'fillOpacity');
  const fillOpacityVal = typeof fillOpacityRaw === 'number' ? fillOpacityRaw : 100;

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

  /**
   * One animatable transform row. Label, unit, range, step, precision and the
   * reset value all come from the property registry — the call site supplies
   * only the prop path, its current value and how to write it, so the same
   * property cannot be described one way here and another in the timeline.
   */
  const renderAnimPropInner = (
    propName: string,
    value: number,
    setVal: (v: number) => void,
  ) => {
    const meta = resolvePropertyMeta(propName, nodeId);
    const label = meta.label;
    const unit = meta.unit;
    const resetVal = meta.resettable && typeof meta.defaultValue === 'number' ? meta.defaultValue : undefined;
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

    // Keyframe navigation, on the property's own time axis.
    const kfs = animated ? defaultAnimation.getTrackKeyframes(nodeId, propName) ?? [] : [];
    const EPS = 1e-4;
    const at = kfs.find((k) => Math.abs(k.t - layerT) < EPS);
    const prev = [...kfs].reverse().find((k) => k.t < layerT - EPS);
    const next = kfs.find((k) => k.t > layerT + EPS);
    const seek = (t: number): void => {
      const compT = keyframeToCompTime(nodeId, t, propName);
      useProjectStore.getState().actions.setTime(compT, Math.round(compT * fps));
    };

    const toggleStopwatch = (): void => {
      if (animated) {
        runAnimEdit(`Remove ${propName} animation`, () => defaultAnimation.removeTrack(nodeId, propName));
      } else {
        runAnimEdit(`Animate ${propName}`, () =>
          defaultAnimation.setKeyframe(nodeId, propName, layerT, Number(value)),
        );
      }
    };

    return (
      <PropertyRow
        key={propName}
        // The group header already says "Position"; the row says "X". The FULL
        // name still reaches assistive tech through the field's aria-label.
        label={label.replace(/(Position|Scale|Rotation|Anchor Point)\s*/i, '') || label}
        srLabel={label}
        animated={animated}
        onStopwatch={numeric ? toggleStopwatch : undefined}
        navigator={{
          hasPrev: !!prev,
          hasNext: !!next,
          atKeyframe: !!at,
          onPrev: () => prev && seek(prev.t),
          onNext: () => next && seek(next.t),
          onToggleKeyframe: () => {
            if (at) {
              runAnimEdit(`Remove ${propName} keyframe`, () =>
                defaultAnimation.removeKeyframe(nodeId, propName, at.t),
              );
            } else {
              // Adds at the CURRENT value — anchoring a property without
              // changing what it renders.
              runAnimEdit(`Add ${propName} keyframe`, () =>
                defaultAnimation.setKeyframe(nodeId, propName, layerT, Number(displayVal ?? 0)),
              );
            }
          },
        }}
        onReset={resetVal !== undefined ? () => handleChange(resetVal) : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          openContextMenu(
            e.clientX,
            e.clientY,
            buildPropertyMenu({
              nodeId,
              prop: propName,
              layerT,
              value: Number(displayVal ?? 0),
              setValue: setVal,
            }),
          );
        }}
      >
        {/* Rotation rows: AE-style dial (drag = rotate, Shift snaps 15°,
            winds through revolutions) sharing the row's write path. It lives
            INSIDE the value cell, so it can no longer push the number out of
            the column every other row shares. */}
        {ROTATION_PROPS.has(propName) && (
          <AngleDial
            value={Number(displayVal ?? 0)}
            onChange={handleChange}
            aria-label={`${label} dial`}
          />
        )}
        <ValueField
          value={Number(displayVal ?? 0)}
          unit={unit}
          min={meta.min}
          max={meta.max}
          step={meta.step}
          precision={meta.precision}
          onChange={handleChange}
          aria-label={label}
        />
      </PropertyRow>
    );
  };

  // Render a stopwatch icon button directly on a grid cell (outside popover).
  // Each prop carries ITS OWN current value — keying every prop to a single
  // shared value made "Enable animation" on Position write y:= x (the layer
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
        <Icon name="stopwatch" size="sm" />
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
  const isSkewAnimated = defaultAnimation.isAnimated(nodeId, 'skew') || defaultAnimation.isAnimated(nodeId, 'skewAxis');

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

      <div className={styles.inlineRows}>
        {!isCamera && (
          <>
            {subhead('Anchor', isAnchorAnimated, renderStopwatchBtn([
              { prop: 'anchorX', value: anchorXVal },
              { prop: 'anchorY', value: anchorYVal },
            ]))}
            {/*
              AE semantics: typing an anchor value MOVES the layer.

              Anchor Point is a coordinate in the layer's own space and Position
              says where that point sits in the parent, so moving the anchor
              inside the layer shifts the content by −R·S·Δanchor. Compensating
              here is what the Pan Behind tool (Y) is for, and it is a separate
              gesture in AE precisely because the two are different intentions.

              These rows used to call `moveAnchorCompensated`, which was neither
              AE nor self-consistent: `renderAnimPropInner` routes ANIMATED
              properties straight to `setKeyframe` and never calls this writer,
              so the compensation silently vanished the moment the anchor
              carried a track. One field, three behaviours, decided by keyframe
              state that has nothing to do with anchoring.
            */}
            {renderAnimPropInner('anchorX', anchorXVal, (v) => {
              setAnchor(nodeId, v, anchorYVal);
            })}
            {renderAnimPropInner('anchorY', anchorYVal, (v) => {
              setAnchor(nodeId, anchorXVal, v);
            })}
            {is3D && renderAnimPropInner('anchorZ', anchorZVal, (v) => setAnchorZ(v))}
          </>
        )}

        {subhead('Position', isPositionAnimated, renderStopwatchBtn([
          { prop: 'x', value: xVal },
          { prop: 'y', value: yVal },
          ...(isCamera || is3D ? [{ prop: 'z', value: zVal }] : []),
        ]))}
        {renderAnimPropInner('x', xVal, (v) => setXVal(v))}
        {renderAnimPropInner('y', yVal, (v) => setYVal(v))}
        {(isCamera || is3D) && renderAnimPropInner('z', zVal, (v) => setZVal(v))}

        <div className={styles.subhead}>
          <span>Scale</span>
          <button
            type="button"
            onClick={() => setLinkedScale(!linkedScale)}
            className={`${styles.lockBtn} ${linkedScale ? styles.lockBtnActive : ''}`}
            title={linkedScale ? 'Unlink Scale dimensions' : 'Link Scale dimensions (Uniform Zoom)'}
            style={{ marginLeft: 6 }}
          >
            <Icon name={linkedScale ? 'lock' : 'unlock'} size="sm" />
          </button>
          {isScaleAnimated && <span className={styles.animatedDot} />}
          <span style={{ flex: 1 }} />
          {renderStopwatchBtn([
            { prop: 'scaleX', value: scaleXVal },
            { prop: 'scaleY', value: scaleYVal },
          ])}
        </div>
        {renderAnimPropInner('scaleX', scaleXVal, (v) => setScaleXVal(v))}
        {renderAnimPropInner('scaleY', scaleYVal, (v) => setScaleYVal(v))}

        {subhead('Rotation', isRotationAnimated, renderStopwatchBtn([
          { prop: 'rotation', value: rotVal },
          ...(is3D
            ? [
                { prop: 'rotationX', value: rotXVal },
                { prop: 'rotationY', value: rotYVal },
              ]
            : []),
        ]))}
        {renderAnimPropInner('rotation', rotVal, (v) => setRotVal(v))}
        {is3D && (
          <>
            {renderAnimPropInner('rotationX', rotXVal, (v) => setRotXVal(v))}
            {renderAnimPropInner('rotationY', rotYVal, (v) => setRotYVal(v))}
            {renderAnimPropInner('orientationX', oriXVal, (v) => setOriX(v))}
            {renderAnimPropInner('orientationY', oriYVal, (v) => setOriY(v))}
            {renderAnimPropInner('orientationZ', oriZVal, (v) => setOriZ(v))}
          </>
        )}

        {widthVal !== undefined && heightVal !== undefined && (
          <>
            {subhead('Size', isSizeAnimated, renderStopwatchBtn([
              { prop: 'width', value: widthVal },
              { prop: 'height', value: heightVal },
            ]))}
            {renderAnimPropInner('width', widthVal, (v) => setWidthVal(v))}
            {renderAnimPropInner('height', heightVal, (v) => setHeightVal(v))}
          </>
        )}

        {/* Skew — a shear applied between rotation and scale. `skewAxis` turns
            the horizontal default into any direction. */}
        {subhead('Skew', isSkewAnimated, renderStopwatchBtn([
          { prop: 'skew', value: skewVal },
        ]))}
        {renderAnimPropInner('skew', skewVal, (v) => setSkew(v))}
        {renderAnimPropInner('skewAxis', skewAxisVal, (v) => setSkewAxis(v))}

        {sComp && (
          <>
            {subhead('Opacity', isOpacityAnimated, renderStopwatchBtn([{ prop: 'opacity', value: opacityVal }]))}
            {renderAnimPropInner('opacity', opacityVal, (v) => setOpacityVal(v))}
            {/* Fill opacity fades the layer's pixels but not its styles — at 0
                a shadowed layer leaves the shadow floating. */}
            {renderAnimPropInner('fillOpacity', fillOpacityVal, (v) => setFillOpacity(v))}
          </>
        )}
      </div>
    </div>
  );
}

export default TransformSection;
