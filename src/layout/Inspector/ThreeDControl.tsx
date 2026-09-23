/**
 * ThreeDControl — the layer's "3D Layer" switch and its Geometry Options.
 *
 * Turning it on adds depth props (Z, X-rotation, Y-rotation) to the layer, so
 * the NodeInspector below renders keyframeable rows for them and the renderer
 * projects the layer through the composition camera (perspective scale +
 * parallax + tilt). Turning it off removes them and the layer is flat 2D again.
 *
 * GEOMETRY ONLY. Material Options, the per-face colour overrides and the
 * material library all moved to `MaterialSection`, which the inspector mounts
 * as its own section directly after this one. They were nested two levels deep
 * inside this panel's 3D sub-panel, under a "Geometry Options" heading they had
 * nothing to do with — so "what this layer is shaped like" and "what it is made
 * of" were one scroll of one collapsed group, and the material presets were in
 * a third panel entirely.
 *
 * Geometry Options follows AE's group: Bevel Style, Bevel Depth, Hole Bevel
 * Depth (text and paths — the only outlines with counters) and Extrusion
 * Depth. The three depths are keyframeable exactly as the renderer reads them
 * (`a.get('extrusionDepth' | 'bevelDepth' | 'holeBevelDepth')`), so each row
 * carries a stopwatch and writes a keyframe at the playhead once animated —
 * a static write under a live track would be invisible.
 */

import { type ReactNode } from 'react';
import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import {
  is3DEnabled,
  canBe3D,
  readNode3D,
  setNodeExtrusionDepth,
  setNodeBevelDepth,
  setNodeHoleBevelDepth,
  setNodeBevelStyle,
  BEVEL_STYLES,
  isPerChar3D,
  setNodePerChar3D,
} from '@core/scene/threeD';
import type { BevelStyle } from '@core/scene/extrusion';
import { hasTextComponent } from '@core/text/textAnimators';
import { readNodeLayerStyles } from '@core/effects/layerStyles';
import { notifyCameraTipIfMissing } from '@core/workspace/cameraNav';
import { useUIStore } from '@stores/uiStore';
import { AnimToggle } from './AnimToggle';
import { allAddressable, scalarValueCommands, setLayersSwitch, stopwatchCommands } from './inspectorEdits';
import { useEngineEdit } from './useEngineEdit';
import s from './ThreeDControl.module.css';

/** Menu labels for the bevel profiles — the union stays the source of truth. */
const BEVEL_STYLE_LABELS: Record<BevelStyle, string> = {
  angular: 'Angular',
  concave: 'Concave',
  convex: 'Convex',
};

interface DepthRowProps {
  nodeId: string;
  prop: 'extrusionDepth' | 'bevelDepth' | 'holeBevelDepth';
  label: string;
  ariaLabel: string;
  /** The static value (what readNode3D reports). */
  base: number;
  min: number;
  max: number;
  unit: string;
  /** Playhead on this layer's own keyframe axis (display + the legacy writer). */
  layerT: number;
  /** Playhead, comp seconds (the engine route). */
  time: number;
  autoKeyframe: boolean;
  /** The static write — the setter that knows the prop's default and clamp. */
  onStatic: (v: number) => void;
}

/**
 * One keyframeable geometry row. The set of rows changes with the layer's
 * state (no bevel ⇒ no hole row); each row is its own component, so its one
 * hook (the scrub gesture) never shifts the section's hook count.
 *
 * B3: through the engine API (`geometry/<prop>`) when its catalog lists the
 * property on this layer; otherwise the legacy writers below.
 */
function DepthRow({ nodeId, prop, label, ariaLabel, base, min, max, unit, layerT, time, autoKeyframe, onStatic }: DepthRowProps): JSX.Element {
  const e = useEngineEdit();
  const animated = defaultAnimation.isAnimated(nodeId, prop);
  const value = animated ? defaultAnimation.sample(nodeId, prop, layerT) ?? base : base;
  const onEngine = (): boolean => allAddressable([nodeId], [prop]);
  const write = (v: number): void => {
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(min, Math.min(max, v));
    if (onEngine()) {
      e.send(`Set ${label}`, scalarValueCommands(prop, [{ nodeId, value: clamped }], { seconds: time, autoKeyframe }));
      return;
    }
    if (animated || autoKeyframe) {
      // B3-legacy: engine gap — a geometry depth the catalog does not list on this layer (Hole Bevel Depth outside text/paths).
      runAnimEdit(
        `Set ${label}`,
        () => defaultAnimation.setKeyframe(nodeId, prop, layerT, clamped),
        `set:${nodeId}:${prop}:${layerT}`,
      );
    } else {
      onStatic(clamped);
    }
  };
  return (
    <div className={s.row}>
      <AnimToggle
        nodeId={nodeId}
        tracks={[prop]}
        label={label}
        animated={animated}
        values={() => [value]}
        onToggle={() => {
          if (onEngine()) {
            e.send(animated ? `Remove ${label} animation` : `Animate ${label}`, stopwatchCommands([nodeId], [prop], time));
            return;
          }
          // B3-legacy: engine gap — same (a depth outside the catalog).
          if (animated) runAnimEdit(`Remove ${label} animation`, () => defaultAnimation.removeTrack(nodeId, prop));
          else runAnimEdit(`Animate ${label}`, () => defaultAnimation.setKeyframe(nodeId, prop, layerT, value));
        }}
      />
      <span className={`${s.label}${animated ? ` ${s.labelAnimated}` : ''}`}>{label}</span>
      <ValueField
        value={Math.round(value * 10) / 10}
        min={min}
        max={max}
        step={1}
        unit={unit}
        onChange={write}
        {...e.scrub(`Set ${label}`, onEngine)}
        aria-label={ariaLabel}
      />
    </div>
  );
}

export interface ThreeDControlProps {
  nodeId: string;
  children?: ReactNode;
}

export function ThreeDControl({ nodeId, children }: ThreeDControlProps): JSX.Element | null {
  // Every hook before the early returns (conditionalHooks.test.tsx).
  useSceneRevision((st) => st.rev);
  // Keyframe writes do not bump the scene revision; without this a lit
  // stopwatch and the values its track drives would not repaint.
  useAnimationRevision();
  const time = useActiveWorkspace()?.time ?? 0;
  const autoKeyframe = usePreferenceStore((st) => st.timelineAutoKeyframe);

  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || nodeId === 'comp_root') return null;
  // Only kinds the renderer can actually project in 3D get the switch —
  // groups / nulls / cameras / lights / solids / particles etc. are excluded
  // by the shared canBe3D predicate (single source of truth with the timeline
  // cube and the viewport 3D badge).
  if (!canBe3D(node)) return null;

  const on = is3DEnabled(node);
  const three = readNode3D(node);
  // B3-legacy: display read (animated depths drawn at the playhead) + the legacy depth writer's key axis.
  const layerT = compToKeyframeTime(nodeId, time);
  // Per-character 3D is a text-only affordance (AE parity).
  const isTextLayer = hasTextComponent(node);
  // Counters exist only on traced outlines: text and free paths.
  const shapeType = node.components.find((c) => c.type === 'Transform')?.props.shapeType;
  const hasHoles = isTextLayer || (typeof shapeType === 'string' && shapeType !== 'rect' && shapeType !== 'ellipse');
  // Animated depths decide visibility by the value drawn NOW, like the renderer.
  const sampled = (prop: 'extrusionDepth' | 'bevelDepth', base: number): number =>
    defaultAnimation.isAnimated(nodeId, prop) ? defaultAnimation.sample(nodeId, prop, layerT) ?? base : base;
  const depthNow = sampled('extrusionDepth', three.extrusionDepth);
  const bevelNow = sampled('bevelDepth', three.bevelDepth);
  const extrudedAtAll = depthNow > 0 || defaultAnimation.isAnimated(nodeId, 'extrusionDepth');
  const bevelledAtAll = bevelNow > 0 || defaultAnimation.isAnimated(nodeId, 'bevelDepth');
  const styled = hasHoles && extrudedAtAll && readNodeLayerStyles(node) !== undefined;

  return (
    <div className={s.stack}>
      <div className={s.switchRow}>
        <span className={s.switchLabel}>3D Layer</span>
        <Switch
          checked={on}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            void setLayersSwitch([nodeId], { threeD: next }, next ? 'Enable 3D Layer' : 'Disable 3D Layer');
            if (next) {
              notifyCameraTipIfMissing((message, level) =>
                useUIStore.getState().notify({ level, message, durationMs: 3200 }),
              );
            }
          }}
          aria-label="3D layer"
        />
      </div>

      {on && (
        <div className={s.items}>
          {children}
          {isTextLayer && (
            <div className={s.row}>
              <span className={s.label}>Per-character 3D</span>
              <Switch
                checked={isPerChar3D(node)}
                // B3-legacy: engine gap — Per-character 3D (a text layer flag) has no switch or property in the API.
                onChange={(e) => setNodePerChar3D(nodeId, e.currentTarget.checked)}
                aria-label="Enable per-character 3D"
              />
            </div>
          )}

          <div className={s.groupHeading}>Geometry Options</div>
          {/* Bevel PROFILE. Only meaningful once there is a chamfer to shape,
              so it rides with Bevel Depth rather than standing alone above a
              depth of 0 where every option would look identical. */}
          {extrudedAtAll && bevelledAtAll && (
            <div className={s.row}>
              <span className={s.label}>Bevel Style</span>
              <select
                className={s.select}
                value={three.bevelStyle}
                // B3-legacy: engine gap — Bevel Style (an enum on the Transform component) is not a `geometry/bevelStyle` choice property in the catalog.
                onChange={(e) => setNodeBevelStyle(nodeId, e.currentTarget.value as BevelStyle)}
                aria-label="Bevel style"
              >
                {BEVEL_STYLES.map((style) => (
                  <option key={style} value={style}>
                    {BEVEL_STYLE_LABELS[style]}
                  </option>
                ))}
              </select>
            </div>
          )}
          {extrudedAtAll && (
            <DepthRow
              nodeId={nodeId}
              prop="bevelDepth"
              label="Bevel Depth"
              ariaLabel="Bevel depth"
              base={three.bevelDepth}
              min={0}
              max={200}
              unit="px"
              layerT={layerT}
              time={time}
              autoKeyframe={autoKeyframe}
              // B3-legacy: engine gap — a geometry depth outside the catalog (static writer fallback).
              onStatic={(v) => setNodeBevelDepth(nodeId, v)}
            />
          )}
          {extrudedAtAll && bevelledAtAll && hasHoles && (
            <DepthRow
              nodeId={nodeId}
              prop="holeBevelDepth"
              label="Hole Bevel Depth"
              ariaLabel="Hole bevel depth"
              base={three.holeBevelDepth}
              min={0}
              max={100}
              unit="%"
              layerT={layerT}
              time={time}
              autoKeyframe={autoKeyframe}
              // B3-legacy: engine gap — a geometry depth outside the catalog (static writer fallback).
              onStatic={(v) => setNodeHoleBevelDepth(nodeId, v)}
            />
          )}
          <DepthRow
            nodeId={nodeId}
            prop="extrusionDepth"
            label="Extrusion Depth"
            ariaLabel="Extrusion depth"
            base={three.extrusionDepth}
            min={0}
            max={1000}
            unit="px"
            layerT={layerT}
            time={time}
            autoKeyframe={autoKeyframe}
            // B3-legacy: engine gap — a geometry depth outside the catalog (static writer fallback).
            onStatic={(v) => setNodeExtrusionDepth(nodeId, v)}
          />
          {styled && (
            <p className={s.hint}>
              Layer styles draw on the front face; the sides and bevels take the fill and material colours.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default ThreeDControl;
