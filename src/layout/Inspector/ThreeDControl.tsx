/**
 * ThreeDControl — the layer's "3D Layer" switch in the inspector.
 *
 * Turning it on adds depth props (Z, X-rotation, Y-rotation) to the layer, so
 * the NodeInspector below renders keyframeable rows for them and the renderer
 * projects the layer through the composition camera (perspective scale +
 * parallax + tilt). Turning it off removes them and the layer is flat 2D again.
 */

import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled, set3DEnabled, canBe3D, readNode3D, setNodeExtrusionDepth, setNodeBevelDepth, isPerChar3D, setNodePerChar3D } from '@core/scene/threeD';
import { hasTextComponent } from '@core/text/textAnimators';
import { notifyCameraTipIfMissing } from '@core/workspace/cameraNav';
import { useUIStore } from '@stores/uiStore';
import styles from './ParentControl.module.css';
import { FaceMaterialsSection } from './FaceMaterialsSection';

import { readNodeMaterial, setNodeCastsShadows, setNodeAcceptsLights, setNodeSpecular, setNodeShininess } from '@core/scene/material';

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
  const material = readNodeMaterial(node);
  const three = readNode3D(node);
  // Per-character 3D is a text-only affordance (AE parity).
  const isTextLayer = hasTextComponent(node);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div className={styles.row}>
        <span className={styles.label}>3D Layer</span>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingLeft: 8, borderLeft: '2px solid var(--color-border-subtle, rgba(255,255,255,0.1))', marginTop: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
            Geometry Options
          </span>
          {isTextLayer && (
            <div className={styles.row}>
              <span className={styles.label} style={{ fontSize: 11 }}>Per-character 3D</span>
              <Switch
                checked={isPerChar3D(node)}
                onChange={(e) => setNodePerChar3D(nodeId, e.currentTarget.checked)}
                aria-label="Enable per-character 3D"
              />
            </div>
          )}
          <div className={styles.row}>
            <span className={styles.label} style={{ fontSize: 11 }}>Extrusion Depth</span>
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
            <div className={styles.row}>
              <span className={styles.label} style={{ fontSize: 11 }}>Bevel Depth</span>
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
          <FaceMaterialsSection nodeId={nodeId} />
          <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2, marginTop: 4 }}>
            Material Options
          </span>
          <div className={styles.row}>
            <span className={styles.label} style={{ fontSize: 11 }}>Casts Shadows</span>
            <Switch
              checked={material.castsShadows}
              onChange={(e) => setNodeCastsShadows(nodeId, e.currentTarget.checked)}
              aria-label="Casts shadows"
            />
          </div>
          <div className={styles.row}>
            <span className={styles.label} style={{ fontSize: 11 }}>Accepts Lights</span>
            <Switch
              checked={material.acceptsLights}
              onChange={(e) => setNodeAcceptsLights(nodeId, e.currentTarget.checked)}
              aria-label="Accepts lights"
            />
          </div>
          {material.acceptsLights && (
            <>
              <div className={styles.row}>
                <span className={styles.label} style={{ fontSize: 11 }}>Specular</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={material.specular}
                  onChange={(e) => setNodeSpecular(nodeId, Number(e.currentTarget.value))}
                  aria-label="Specular intensity"
                  style={{ width: 90 }}
                />
              </div>
              <div className={styles.row}>
                <span className={styles.label} style={{ fontSize: 11 }}>Shininess</span>
                <input
                  type="range"
                  min={1}
                  max={128}
                  step={1}
                  value={material.shininess}
                  onChange={(e) => setNodeShininess(nodeId, Number(e.currentTarget.value))}
                  aria-label="Shininess"
                  style={{ width: 90 }}
                />
              </div>
            </>
          )}
          {/* The "Pro 3D Material Presets" grid lived here. It was a third
              hard-coded preset grid, in a panel that does not own fill — picking
              one silently replaced the layer's colour. The same six materials
              are now in the Style panel's preset registry under "Material",
              alongside every other look, and they set specular/shininess through
              the same apply path. */}
        </div>
      )}
    </div>
  );
}

export default ThreeDControl;

