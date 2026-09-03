/**
 * ThreeDControl — the layer's "3D Layer" switch in the inspector.
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
 */

import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import {
  is3DEnabled,
  set3DEnabled,
  canBe3D,
  readNode3D,
  setNodeExtrusionDepth,
  setNodeBevelDepth,
  setNodeBevelStyle,
  BEVEL_STYLES,
  isPerChar3D,
  setNodePerChar3D,
} from '@core/scene/threeD';
import type { BevelStyle } from '@core/scene/extrusion';
import { hasTextComponent } from '@core/text/textAnimators';
import { notifyCameraTipIfMissing } from '@core/workspace/cameraNav';
import { useUIStore } from '@stores/uiStore';
import parentStyles from './ParentControl.module.css';
import s from './ThreeDControl.module.css';

/** Menu labels for the bevel profiles — the union stays the source of truth. */
const BEVEL_STYLE_LABELS: Record<BevelStyle, string> = {
  angular: 'Angular',
  concave: 'Concave',
  convex: 'Convex',
};

export function ThreeDControl({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || nodeId === 'comp_root') return null;
  // Only kinds the renderer can actually project in 3D get the switch —
  // groups / nulls / cameras / lights / solids / particles etc. are excluded
  // by the shared canBe3D predicate (single source of truth with the timeline
  // cube and the viewport 3D badge).
  if (!canBe3D(node)) return null;

  const on = is3DEnabled(node);
  const three = readNode3D(node);
  // Per-character 3D is a text-only affordance (AE parity).
  const isTextLayer = hasTextComponent(node);

  return (
    <div className={s.stack}>
      <div className={parentStyles.row}>
        <span className={parentStyles.label}>3D Layer</span>
        <Switch
          checked={on}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            set3DEnabled(nodeId, next);
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
        <div className={s.subPanel}>
          <span className={s.groupHeader}>Geometry Options</span>
          {isTextLayer && (
            <div className={s.row}>
              <span className={s.label}>Per-character 3D</span>
              <Switch
                checked={isPerChar3D(node)}
                onChange={(e) => setNodePerChar3D(nodeId, e.currentTarget.checked)}
                aria-label="Enable per-character 3D"
              />
            </div>
          )}
          <div className={s.row}>
            <span className={s.label}>Extrusion Depth</span>
            <ValueField
              value={three.extrusionDepth}
              min={0}
              max={1000}
              step={1}
              unit="px"
              onChange={(v) => setNodeExtrusionDepth(nodeId, v)}
              aria-label="Extrusion depth"
            />
          </div>
          {three.extrusionDepth > 0 && (
            <div className={s.row}>
              <span className={s.label}>Bevel Depth</span>
              <ValueField
                value={three.bevelDepth}
                min={0}
                max={200}
                step={1}
                unit="px"
                onChange={(v) => setNodeBevelDepth(nodeId, v)}
                aria-label="Bevel depth"
              />
            </div>
          )}
          {/* Bevel PROFILE. Only meaningful once there is a chamfer to shape,
              so it rides with Bevel Depth rather than standing alone above a
              depth of 0 where every option would look identical. */}
          {three.extrusionDepth > 0 && three.bevelDepth > 0 && (
            <div className={s.row}>
              <span className={s.label}>Bevel Style</span>
              <select
                className={s.select}
                value={three.bevelStyle}
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
        </div>
      )}
    </div>
  );
}

export default ThreeDControl;
